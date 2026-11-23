import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAIN_IDS,
  KovanicaAbortError,
  NETWORK_TAGS,
  bytesToHex,
  encodeAddress,
  getPublicKey,
  hexToBytes,
  signCallContractTransaction,
  type FailoverEvent,
  type FinalityProgress,
} from "kovanica-sdk";
import {
  DEFAULT_FEE_BUFFER_MULTIPLIER_BPS,
  computeBufferedTxFee,
  createWalletFailoverClient,
  formatFinalityProgressBadge,
  probeWalletRpcEndpoint,
  verifySignedCallTxBeforeBroadcast,
  watchSubmittedTxFinality,
} from "./finality.ts";

function jsonRpcResponse(id: number | string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("wallet multi-RPC failover and finality helpers", () => {
  const validTxHash = `0x${"ab".repeat(32)}`;

  it("deduplicates URLs, filters invalid schemes, sanitizes endpoints, and fails over from primary 503 to backup", async () => {
    const primaryRaw = "http://user:secret@primary.kovanica.test:8545/rpc?token=supersecret";
    const backupRaw = "https://backup.kovanica.test/rpc?api_key=hidden";

    const requestedUrls: string[] = [];
    const failoverEvents: FailoverEvent[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      requestedUrls.push(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number | string;
        method: string;
      };

      if (url.startsWith("http://user:secret@primary.kovanica.test:8545")) {
        return new Response("service unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }

      if (url.startsWith("https://backup.kovanica.test/rpc") && body.method === "kovanica_blockNumber") {
        return jsonRpcResponse(body.id, "0x2a");
      }

      return new Response("not found", { status: 404 });
    };

    const { client, endpoints } = createWalletFailoverClient(
      primaryRaw,
      [
        primaryRaw,
        "javascript:alert(1)",
        "ftp://ftp.kovanica.test/rpc",
        "file:///etc/passwd",
        "not-a-valid-url",
        "",
        backupRaw,
        backupRaw,
      ],
      {
        fetch: mockFetch,
        maxRetriesPerEndpoint: 0,
        baseBackoffMs: 0,
        onFailover: (event) => failoverEvents.push(event),
      },
    );

    assert.deepEqual(endpoints, [
      "http://primary.kovanica.test:8545/rpc",
      "https://backup.kovanica.test/rpc",
    ]);

    const height = await client.blockNumber();
    assert.equal(height, 42n);
    assert.equal(requestedUrls.length, 2);
    assert.equal(requestedUrls[0], primaryRaw);
    assert.equal(requestedUrls[1], backupRaw);

    assert.equal(failoverEvents.length, 1);
    assert.equal(failoverEvents[0]?.fromUrl, "http://primary.kovanica.test:8545/rpc");
    assert.equal(failoverEvents[0]?.toUrl, "https://backup.kovanica.test/rpc");
    assert.equal(failoverEvents[0]?.status, 503);

    assert.throws(
      () => createWalletFailoverClient("javascript:void(0)", ["ftp://bad.test", ""]),
      /valid http\(s\) RPC URL/i,
    );
  });

  it("tracks live finality progress across pending -> included -> finalized with multi-RPC failover", async () => {
    let receiptPolls = 0;
    let tipHeight = 100n;
    const progressUpdates: FinalityProgress[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number | string;
        method: string;
      };

      if (url.includes("primary-down.kovanica.test")) {
        return new Response("upstream overloaded", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }

      if (body.method === "kovanica_getTransactionReceipt") {
        receiptPolls += 1;
        if (receiptPolls === 1) {
          return jsonRpcResponse(body.id, null);
        }
        return jsonRpcResponse(body.id, {
          transactionHash: validTxHash,
          blockHash: `0x${"cd".repeat(32)}`,
          blockNumber: "0x64", // 100
          transactionIndex: "0x0",
          status: 1,
          success: true,
          gasUsed: "0x5208",
          logs: [],
        });
      }

      if (body.method === "kovanica_blockNumber") {
        const current = tipHeight;
        tipHeight += 1n;
        return jsonRpcResponse(body.id, `0x${current.toString(16)}`);
      }

      return new Response("unexpected method", { status: 400 });
    };

    const result = await watchSubmittedTxFinality(
      ["http://primary-down.kovanica.test:8545/rpc", "http://backup-ok.kovanica.test:8545/rpc"],
      validTxHash,
      {
        confirmations: 3,
        pollIntervalMs: 1,
        timeoutMs: 5_000,
        sleep: async () => {},
        onProgress: (update) => progressUpdates.push(update),
        clientOptions: {
          fetch: mockFetch,
          maxRetriesPerEndpoint: 0,
          baseBackoffMs: 0,
        },
      },
    );

    assert.equal(result.txHash, validTxHash);
    assert.equal(result.blockHeight, 100n);
    assert.equal(result.currentHeight, 102n);
    assert.equal(result.confirmations, 3);
    assert.equal(result.receipt.status, 1);

    assert.deepEqual(
      progressUpdates.map((u) => ({
        status: u.status,
        confirmations: u.confirmations,
        targetConfirmations: u.targetConfirmations,
      })),
      [
        { status: "pending", confirmations: 0, targetConfirmations: 3 },
        { status: "included", confirmations: 1, targetConfirmations: 3 },
        { status: "included", confirmations: 2, targetConfirmations: 3 },
        { status: "finalized", confirmations: 3, targetConfirmations: 3 },
      ],
    );
  });

  it("aborts watchSubmittedTxFinality immediately when AbortSignal fires", async () => {
    const controller = new AbortController();
    let polls = 0;

    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number | string;
        method: string;
      };
      polls += 1;
      if (body.method === "kovanica_getTransactionReceipt") {
        return jsonRpcResponse(body.id, null);
      }
      return jsonRpcResponse(body.id, "0x1");
    };

    await assert.rejects(
      () =>
        watchSubmittedTxFinality("http://node.kovanica.test:8545/rpc", validTxHash, {
          confirmations: 2,
          pollIntervalMs: 50,
          timeoutMs: 5_000,
          signal: controller.signal,
          onProgress: () => {
            controller.abort();
          },
          clientOptions: {
            fetch: mockFetch,
            maxRetriesPerEndpoint: 0,
            baseBackoffMs: 0,
          },
        }),
      (err: unknown) => err instanceof KovanicaAbortError,
    );

    assert.equal(polls, 1);
  });

  it("formats finality progress badges for pending, included, and finalized states", () => {
    assert.deepEqual(
      formatFinalityProgressBadge({
        txHash: validTxHash,
        status: "pending",
        confirmations: 0,
        targetConfirmations: 1,
        elapsedMs: 120,
      }),
      {
        label: "Pending",
        tone: "pending",
        confirmationsText: "0/1 confirmation",
      },
    );

    assert.deepEqual(
      formatFinalityProgressBadge({
        txHash: validTxHash,
        status: "included",
        confirmations: 2,
        targetConfirmations: 3,
        blockHeight: 100n,
        currentHeight: 101n,
        elapsedMs: 1_500,
      }),
      {
        label: "Included",
        tone: "included",
        confirmationsText: "2/3 confirmations",
      },
    );

    assert.deepEqual(
      formatFinalityProgressBadge({
        txHash: validTxHash,
        status: "finalized",
        confirmations: 3,
        targetConfirmations: 3,
        blockHeight: 100n,
        currentHeight: 102n,
        elapsedMs: 3_200,
      }),
      {
        label: "Finalized",
        tone: "finalized",
        confirmationsText: "3/3 confirmations",
      },
    );
  });

  it("computes ceiling-rounded buffered transaction fees via applyFeeBuffer", () => {
    const defaultEstimate = computeBufferedTxFee(1_000n);
    assert.equal(defaultEstimate.baseFee, 1_000n);
    assert.equal(defaultEstimate.safetyMultiplierBps, DEFAULT_FEE_BUFFER_MULTIPLIER_BPS);
    assert.equal(defaultEstimate.bufferedFee, 1_200n);
    assert.equal(defaultEstimate.capped, false);

    // Verify ceiling rounding on non-divisible base fee: ceil(101 * 11500 / 10000) = ceil(116.15) = 117
    const customEstimate = computeBufferedTxFee(101n, 11_500);
    assert.equal(customEstimate.baseFee, 101n);
    assert.equal(customEstimate.safetyMultiplierBps, 11_500);
    assert.equal(customEstimate.bufferedFee, 117n);
    assert.equal(customEstimate.capped, false);

    assert.throws(() => computeBufferedTxFee(-1n), /non-negative/i);
    assert.throws(() => computeBufferedTxFee(100n, 9_999), /10000/);
  });

  it("verifies a valid signed call transaction before broadcast and enforces expectedContract", () => {
    const secretKey = new Uint8Array(32).fill(0x11);
    const publicKey = getPublicKey(secretKey);
    const contractBytes = new Uint8Array(32).fill(0x42);
    const contractHex = `0x${bytesToHex(contractBytes)}`;
    const contractAddress = encodeAddress(contractBytes);

    const signed = signCallContractTransaction({
      sender: publicKey,
      secretKey,
      call: {
        contract: contractBytes,
        method: "transfer",
        args: new Uint8Array([1, 2, 3, 4]),
        call_value: 0n,
        gas_limit: 50_000n,
      },
      nonce: 7n,
      fee: 1_500n,
      chainId: CHAIN_IDS.TESTNET,
    });

    const okHex = verifySignedCallTxBeforeBroadcast(signed.rawTxHex, publicKey, {
      chainId: BigInt(CHAIN_IDS.TESTNET),
      expectedContract: contractHex,
    });
    assert.equal(okHex.ok, true);
    assert.equal(okHex.signatureValid, true);
    assert.equal(okHex.error, undefined);
    assert.equal(okHex.decoded?.method, "transfer");
    assert.equal(okHex.decoded?.nonce, 7n);
    assert.equal(okHex.decoded?.fee, 1_500n);
    assert.equal(okHex.decoded?.chainId, CHAIN_IDS.TESTNET);
    assert.equal(okHex.decoded?.contractHex, contractHex);

    const okAddr = verifySignedCallTxBeforeBroadcast(`0x${signed.rawTxHex}`, publicKey, {
      chainId: CHAIN_IDS.TESTNET,
      expectedContract: contractAddress,
    });
    assert.equal(okAddr.ok, true);
    assert.equal(okAddr.signatureValid, true);
  });

  it("fails closed on tampered signature, wrong expected contract, wrong public key, or corrupted hex", () => {
    const secretKey = new Uint8Array(32).fill(0x22);
    const publicKey = getPublicKey(secretKey);
    const otherPublicKey = getPublicKey(new Uint8Array(32).fill(0x33));
    const contractBytes = new Uint8Array(32).fill(0x55);
    const wrongContractBytes = new Uint8Array(32).fill(0x66);

    const signed = signCallContractTransaction({
      sender: publicKey,
      secretKey,
      call: {
        contract: contractBytes,
        method: "mint",
        args: new Uint8Array([0xaa, 0xbb]),
        call_value: 10n,
        gas_limit: 100_000n,
      },
      nonce: 3n,
      fee: 2_000n,
      chainId: CHAIN_IDS.TESTNET,
    });

    // Tamper with a byte inside the 64-byte signature (located right before the trailing 32-byte wireHash).
    const tamperedBytes = hexToBytes(signed.rawTxHex);
    const sigByteIndex = tamperedBytes.length - 32 - 1;
    tamperedBytes[sigByteIndex] = tamperedBytes[sigByteIndex]! ^ 0xff;
    const tamperedResult = verifySignedCallTxBeforeBroadcast(
      bytesToHex(tamperedBytes),
      publicKey,
      { chainId: CHAIN_IDS.TESTNET },
    );
    assert.equal(tamperedResult.ok, false);
    assert.equal(tamperedResult.signatureValid, false);
    assert.match(tamperedResult.error ?? "", /signature/i);

    // Wrong expected contract.
    const wrongContractResult = verifySignedCallTxBeforeBroadcast(signed.rawTxHex, publicKey, {
      chainId: CHAIN_IDS.TESTNET,
      expectedContract: `0x${bytesToHex(wrongContractBytes)}`,
    });
    assert.equal(wrongContractResult.ok, false);
    assert.equal(wrongContractResult.signatureValid, true);
    assert.match(wrongContractResult.error ?? "", /contract address mismatch/i);

    // Wrong expected public key.
    const wrongKeyResult = verifySignedCallTxBeforeBroadcast(signed.rawTxHex, otherPublicKey, {
      chainId: CHAIN_IDS.TESTNET,
    });
    assert.equal(wrongKeyResult.ok, false);
    assert.equal(wrongKeyResult.signatureValid, false);
    assert.match(wrongKeyResult.error ?? "", /signature/i);

    // Wrong chainId (signature was computed for Chain 2, verified with Chain 1).
    const wrongChainResult = verifySignedCallTxBeforeBroadcast(signed.rawTxHex, publicKey, {
      chainId: CHAIN_IDS.MAINNET,
    });
    assert.equal(wrongChainResult.ok, false);
    assert.equal(wrongChainResult.signatureValid, false);

    // Corrupted / non-hex input.
    const corruptedHexResult = verifySignedCallTxBeforeBroadcast("0xzzzz-not-hex", publicKey, {
      chainId: CHAIN_IDS.TESTNET,
    });
    assert.equal(corruptedHexResult.ok, false);
    assert.equal(corruptedHexResult.signatureValid, false);
    assert.equal(corruptedHexResult.decoded, undefined);
    assert.match(corruptedHexResult.error ?? "", /invalid hex/i);

    // Truncated bytes.
    const truncatedResult = verifySignedCallTxBeforeBroadcast(
      signed.rawTxHex.slice(0, 32),
      publicKey,
      { chainId: CHAIN_IDS.TESTNET },
    );
    assert.equal(truncatedResult.ok, false);
    assert.equal(truncatedResult.signatureValid, false);
    assert.equal(truncatedResult.decoded, undefined);
  });

  it("probes wallet RPC endpoint, validates Chain 2 X-Kovanica-Network-Tag header, and rejects mismatched canonical tag", async () => {
    const makeBatchMockFetch = (networkTag: string, chainIdHex = "0x2"): typeof fetch => {
      return async (_input, init) => {
        const batch = JSON.parse(String(init?.body ?? "[]")) as Array<{
          id: number;
          method: string;
        }>;
        const responses = batch.map((req) => {
          if (req.method === "kovanica_chainId") {
            return { jsonrpc: "2.0", id: req.id, result: chainIdHex };
          }
          if (req.method === "kovanica_blockNumber") {
            return { jsonrpc: "2.0", id: req.id, result: "0x100" };
          }
          if (req.method === "kovanica_estimateFee") {
            return { jsonrpc: "2.0", id: req.id, result: "0x64" };
          }
          return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Not found" } };
        });

        return new Response(JSON.stringify(responses), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "X-Kovanica-Network-Tag": networkTag,
            "X-Kovanica-Rpc-Version": "1.0.0",
            "X-Kovanica-Chain-Id": "2",
          },
        });
      };
    };

    const validProbe = await probeWalletRpcEndpoint(
      "https://testnet-rpc.kovanica.test/rpc",
      CHAIN_IDS.TESTNET,
      makeBatchMockFetch(NETWORK_TAGS.TESTNET),
    );
    assert.equal(validProbe.ok, true);
    assert.equal(validProbe.batchSupported, true);
    assert.equal(validProbe.chainId, 2n);
    assert.equal(validProbe.blockHeight, 256n);
    assert.equal(validProbe.feeRate, 100n);
    assert.equal(validProbe.networkTag, NETWORK_TAGS.TESTNET);
    assert.equal(validProbe.canonicalTagMatch, true);
    assert.equal(validProbe.error, undefined);

    const mismatchedTagProbe = await probeWalletRpcEndpoint(
      "https://testnet-rpc.kovanica.test/rpc",
      CHAIN_IDS.TESTNET,
      makeBatchMockFetch("2-deadbeefdeadbeef"),
    );
    assert.equal(mismatchedTagProbe.ok, false);
    assert.equal(mismatchedTagProbe.batchSupported, true);
    assert.equal(mismatchedTagProbe.chainId, 2n);
    assert.equal(mismatchedTagProbe.networkTag, "2-deadbeefdeadbeef");
    assert.equal(mismatchedTagProbe.canonicalTagMatch, false);
    assert.match(mismatchedTagProbe.error ?? "", /canonical network tag mismatch/i);

    const wrongChainProbe = await probeWalletRpcEndpoint(
      "https://mainnet-rpc.kovanica.test/rpc",
      CHAIN_IDS.TESTNET,
      makeBatchMockFetch(NETWORK_TAGS.MAINNET, "0x1"),
    );
    assert.equal(wrongChainProbe.ok, false);
    assert.equal(wrongChainProbe.chainId, 1n);
    assert.match(wrongChainProbe.error ?? "", /expected chainId 2, got 1/i);
  });
});
