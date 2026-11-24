import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADDRESS_PREFIX,
  CHAIN_IDS,
  TESTNET_ADDRESS_PREFIX,
  bytesToHex,
  concatBytes,
  encodeAddress,
  encodeBincodeString,
  u64le,
  type PaginatedGetLogsRpcFilter,
  type PaginatedLogsClient,
} from "kovanica-sdk";

import {
  MULTISIG_BUNDLE_FORMAT,
  MULTISIG_BUNDLE_VERSION,
  evaluateMultisigQuorum,
  exportMultisigApprovalBundle,
  fetchContractLogsPage,
  inspectMultisigBundle,
  validatePro21ContractAddress,
} from "./contractLogsAndMultisig.ts";

function makePro21Address(fillByte: number, testnet = true): string {
  const bytes = new Uint8Array(32).fill(fillByte);
  return encodeAddress(bytes, testnet ? TESTNET_ADDRESS_PREFIX : ADDRESS_PREFIX);
}

function makeSigHex(fillByte: number): string {
  return `0x${bytesToHex(new Uint8Array(64).fill(fillByte))}`;
}

function encodeNftStateBincode(name: string, symbol: string, baseUri: string): string {
  const owner = new Uint8Array(32).fill(0x11);
  const minter = new Uint8Array(32).fill(0x22);
  const payload = concatBytes([
    encodeBincodeString(name),
    encodeBincodeString(symbol),
    encodeBincodeString(baseUri),
    owner,
    minter,
    u64le(0n), // 0 tokens
  ]);
  return `0x${bytesToHex(payload)}`;
}

describe("contractLogsAndMultisig — paginated contract logs", () => {
  it("fetches paginated logs across chunks and builds decoded event summaries", async () => {
    const contractAddr = makePro21Address(0xaa, true);
    const encodedNft = encodeNftStateBincode("Kovanica Badges", "KBADGE", "ipfs://badges/");
    const seenFilters: PaginatedGetLogsRpcFilter[] = [];

    const client: PaginatedLogsClient = {
      async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
        assert.equal(method, "kovanica_getLogs");
        const filter = (params as [PaginatedGetLogsRpcFilter])[0];
        seenFilters.push(filter);

        if (filter.fromBlock === "0x0") {
          return {
            logs: [
              {
                address: contractAddr,
                topics: ["0x01"],
                data: encodedNft,
                blockNumber: "0x5",
                logIndex: "0x0",
                transactionHash: "0x" + "ab".repeat(32),
              },
            ],
            nextCursor: null,
          } as TResult;
        }

        return {
          logs: [
            {
              address: contractAddr,
              topics: ["0x02"],
              data: encodedNft,
              blockNumber: "0x10",
              logIndex: "0x1",
              transactionHash: "0x" + "cd".repeat(32),
            },
          ],
          nextCursor: null,
        } as TResult;
      },
    };

    const page = await fetchContractLogsPage(client, {
      contractAddress: contractAddr,
      chainId: CHAIN_IDS.TESTNET,
      fromBlock: 0,
      toBlock: 19,
      maxSpan: 10,
      maxPages: 5,
      pageLimit: 50,
      logKind: "nft_metadata",
    });

    assert.equal(seenFilters.length, 2);
    assert.equal(seenFilters[0]?.fromBlock, "0x0");
    assert.equal(seenFilters[0]?.toBlock, "0x9");
    assert.equal(seenFilters[1]?.fromBlock, "0xa");
    assert.equal(seenFilters[1]?.toBlock, "0x13");

    assert.equal(page.contractAddress, contractAddr);
    assert.equal(page.pagesFetched, 2);
    assert.equal(page.chunksScanned, 2);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);
    assert.equal(page.items.length, 2);
    assert.equal(page.items[0]?.blockHeight, "5");
    assert.equal(page.items[0]?.logIndex, "0");
    assert.equal(page.items[0]?.decodedKind, "nft_metadata");
    assert.ok(page.items[0]?.decodedSummary.includes("Kovanica Badges"));
    assert.equal(page.items[1]?.blockHeight, "16");
    assert.equal(page.items[1]?.logIndex, "1");
  });

  it("supports cursor resumption across sequential fetchContractLogsPage calls", async () => {
    const contractAddr = makePro21Address(0xbb, true);
    const calls: PaginatedGetLogsRpcFilter[] = [];

    const client: PaginatedLogsClient = {
      async getLogs(filter: PaginatedGetLogsRpcFilter) {
        calls.push(filter);
        if (!filter.cursor) {
          return {
            logs: [
              {
                address: contractAddr,
                topics: ["0xaa"],
                data: "0xdeadbeef",
                blockNumber: 100,
                logIndex: 0,
                transactionHash: "0x" + "11".repeat(32),
              },
            ],
            nextCursor: "100:0",
          };
        }
        assert.equal(filter.cursor, "100:0");
        return {
          logs: [
            {
              address: contractAddr,
              topics: ["0xbb"],
              data: "0xcafebabe",
              blockNumber: 105,
              logIndex: 2,
              transactionHash: "0x" + "22".repeat(32),
            },
          ],
          nextCursor: null,
        };
      },
    };

    const first = await fetchContractLogsPage(client, {
      contractAddress: contractAddr,
      chainId: CHAIN_IDS.TESTNET,
      fromBlock: 100,
      toBlock: 200,
      maxSpan: 500,
      maxPages: 1,
      pageLimit: 1,
    });

    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, "100:0");
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]?.blockHeight, "100");

    const second = await fetchContractLogsPage(client, {
      contractAddress: contractAddr,
      chainId: CHAIN_IDS.TESTNET,
      fromBlock: 100,
      toBlock: 200,
      maxSpan: 500,
      maxPages: 1,
      pageLimit: 1,
      cursor: first.nextCursor ?? undefined,
    });

    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
    assert.equal(second.items.length, 1);
    assert.equal(second.items[0]?.blockHeight, "105");
    assert.equal(second.items[0]?.logIndex, "2");
    assert.equal(calls.length, 2);
  });

  it("rejects invalid block ranges, invalid PRO-21 addresses, and invalid cursors before RPC I/O", async () => {
    let rpcCalls = 0;
    const client: PaginatedLogsClient = {
      async getLogs() {
        rpcCalls += 1;
        return [];
      },
    };

    await assert.rejects(
      () =>
        fetchContractLogsPage(client, {
          fromBlock: 500,
          toBlock: 100,
        }),
      /fromBlock \(500\) must be <= toBlock \(100\)/,
    );

    await assert.rejects(
      () =>
        fetchContractLogsPage(client, {
          fromBlock: -1,
          toBlock: 10,
        }),
      /non-negative/,
    );

    await assert.rejects(
      () =>
        fetchContractLogsPage(client, {
          contractAddress: "0x" + "ab".repeat(32),
          chainId: CHAIN_IDS.MAINNET,
          fromBlock: 0,
          toBlock: 10,
        }),
      /PRO-21|legacy/i,
    );

    await assert.rejects(
      () =>
        fetchContractLogsPage(client, {
          fromBlock: 0,
          toBlock: 10,
          maxSpan: 0,
        }),
      /maxSpan/,
    );

    await assert.rejects(
      () =>
        fetchContractLogsPage(client, {
          fromBlock: 0,
          toBlock: 10,
          cursor: "not-a-cursor",
        }),
      /cursor/,
    );

    assert.equal(rpcCalls, 0);

    const badCheck = validatePro21ContractAddress("invalid-addr", CHAIN_IDS.TESTNET);
    assert.equal(badCheck.ok, false);
  });
});

describe("contractLogsAndMultisig — air-gapped multisig bundle & quorum", () => {
  it("exports and inspects a kovanica-multisig-bundle-v1 round-trip with quorum reached", () => {
    const multisigAddress = makePro21Address(0x01, true);
    const signerA = makePro21Address(0x10, true);
    const signerB = makePro21Address(0x20, true);
    const signerC = makePro21Address(0x30, true);

    const exported = exportMultisigApprovalBundle({
      chainId: CHAIN_IDS.TESTNET,
      multisigAddress,
      proposalId: "42",
      threshold: 2,
      signers: [signerC, signerA, signerB],
      approvals: [
        { signer: signerB, signatureHex: makeSigHex(0x2b), signedAtMs: 1_700_000_000_000 },
        { signer: signerA, signatureHex: makeSigHex(0x1a) },
      ],
      payloadHex: "0xdeadbeef",
      description: "Treasury payout #42",
    });

    assert.equal(exported.bundle.format, MULTISIG_BUNDLE_FORMAT);
    assert.equal(exported.bundle.version, MULTISIG_BUNDLE_VERSION);
    assert.equal(exported.bundle.chainId, CHAIN_IDS.TESTNET);
    assert.equal(exported.quorum.quorumReached, true);
    assert.equal(exported.quorum.approvedCount, 2);
    assert.equal(exported.quorum.remainingNeeded, 0);
    assert.ok(exported.quorumSummary.includes("Quorum reached"));

    const inspected = inspectMultisigBundle(exported.json);
    assert.deepEqual(inspected.bundle, exported.bundle);
    assert.equal(inspected.quorum.quorumReached, true);
    assert.equal(inspected.quorum.approvedCount, 2);
    assert.equal(inspected.quorum.uniqueSigners.length, 3);
  });

  it("evaluates partial quorum, unknown approvers, and duplicate approvals accurately", () => {
    const signerA = makePro21Address(0x41, false);
    const signerB = makePro21Address(0x42, false);
    const signerC = makePro21Address(0x43, false);
    const outsider = makePro21Address(0x99, false);

    const quorum = evaluateMultisigQuorum({
      signers: [signerA, signerB, signerC],
      approvals: [signerA, signerA, outsider],
      threshold: 2,
    });

    assert.equal(quorum.quorumReached, false);
    assert.equal(quorum.approvedCount, 1);
    assert.equal(quorum.remainingNeeded, 1);
    assert.deepEqual(quorum.validApprovals, [signerA]);
    assert.deepEqual(quorum.duplicateApprovals, [signerA]);
    assert.deepEqual(quorum.unknownApprovals, [outsider]);
  });

  it("fails closed when private key or secret fields are embedded in bundle JSON", () => {
    const multisigAddress = makePro21Address(0x51, true);
    const signerA = makePro21Address(0x52, true);

    const poisonedJson = JSON.stringify({
      format: MULTISIG_BUNDLE_FORMAT,
      version: MULTISIG_BUNDLE_VERSION,
      chainId: CHAIN_IDS.TESTNET,
      multisigAddress,
      proposalId: "7",
      threshold: 1,
      signers: [signerA],
      approvals: [{ signer: signerA, signatureHex: makeSigHex(0x77) }],
      description: "Poisoned bundle",
      privateKey: "0x" + "ff".repeat(32),
    });

    assert.throws(() => inspectMultisigBundle(poisonedJson), /Forbidden secret\/private key field/);

    const poisonedMnemonic = JSON.stringify({
      format: MULTISIG_BUNDLE_FORMAT,
      version: MULTISIG_BUNDLE_VERSION,
      chainId: CHAIN_IDS.TESTNET,
      multisigAddress,
      proposalId: "8",
      threshold: 1,
      signers: [signerA],
      approvals: [{ signer: signerA, signatureHex: makeSigHex(0x77), mnemonic: "test words" }],
      description: "Poisoned nested",
    });

    assert.throws(
      () => inspectMultisigBundle(poisonedMnemonic),
      /Forbidden secret\/private key field/,
    );
  });
});
