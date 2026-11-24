import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADDRESS_PREFIX,
  CHAIN_IDS,
  MAX_TX_GAS_LIMIT,
  TESTNET_ADDRESS_PREFIX,
  encodeAddress,
} from "kovanica-sdk";

import {
  createEmptyBatchCallDraft,
  parseBatchCallArgs,
  previewBatchContractCalls,
  reorderBatchCalls,
  validateBatchCallDraft,
  type BatchCallDraft,
  type BatchContractCallClient,
} from "./batchCalls.ts";

const CONTRACT_A_BYTES = new Uint8Array(32).fill(0x11);
const CONTRACT_B_BYTES = new Uint8Array(32).fill(0x22);
const SENDER_BYTES = new Uint8Array(32).fill(0xaa);

const MAINNET_CONTRACT_A = encodeAddress(CONTRACT_A_BYTES, ADDRESS_PREFIX);
const MAINNET_CONTRACT_B = encodeAddress(CONTRACT_B_BYTES, ADDRESS_PREFIX);
const TESTNET_CONTRACT_A = encodeAddress(CONTRACT_A_BYTES, TESTNET_ADDRESS_PREFIX);
const TESTNET_CONTRACT_B = encodeAddress(CONTRACT_B_BYTES, TESTNET_ADDRESS_PREFIX);
const TESTNET_SENDER = encodeAddress(SENDER_BYTES, TESTNET_ADDRESS_PREFIX);

function makeMockClient(overrides?: {
  feeRate?: bigint;
  nonce?: bigint;
  onCall?: (method: string, params: unknown, callIndex: number) => Promise<unknown>;
}): {
  client: BatchContractCallClient;
  counts: { estimateFee: number; getNonce: number; call: number };
} {
  const counts = { estimateFee: 0, getNonce: 0, call: 0 };
  const client: BatchContractCallClient = {
    async estimateFee() {
      counts.estimateFee += 1;
      return overrides?.feeRate ?? 100n;
    },
    async getNonce() {
      counts.getNonce += 1;
      return overrides?.nonce ?? 7n;
    },
    async call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
      const idx = counts.call;
      counts.call += 1;
      if (overrides?.onCall) {
        return (await overrides.onCall(method, params, idx)) as TResult;
      }
      return "0x01" as TResult;
    },
  };
  return { client, counts };
}

describe("batchCalls", () => {
  describe("validation and parsing", () => {
    it("validates PRO-21 contract addresses, method, hex/json args, value, and gasLimit", () => {
      const hexDraft: BatchCallDraft = {
        id: "c1",
        contract: TESTNET_CONTRACT_A,
        method: "transfer",
        argsFormat: "hex",
        argsInput: "0xdeadbeef",
        valueAtoms: "500000000",
        gasLimit: "150000",
      };
      const resHex = validateBatchCallDraft(hexDraft, CHAIN_IDS.TESTNET);
      assert.equal(resHex.ok, true);
      if (resHex.ok) {
        assert.equal(resHex.call.contract, TESTNET_CONTRACT_A);
        assert.equal(resHex.call.method, "transfer");
        assert.equal(resHex.call.argsHex, "0xdeadbeef");
        assert.deepEqual(Array.from(resHex.call.args), [0xde, 0xad, 0xbe, 0xef]);
        assert.equal(resHex.call.valueAtoms, 500_000_000n);
        assert.equal(resHex.call.gasLimit, 150_000n);
      }

      const jsonDraft: BatchCallDraft = {
        id: "c2",
        contract: MAINNET_CONTRACT_A,
        method: "mint",
        argsFormat: "json",
        argsInput: '{"to":"alice","amount":42}',
        valueAtoms: "",
        gasLimit: "",
      };
      const resJson = validateBatchCallDraft(jsonDraft, CHAIN_IDS.MAINNET);
      assert.equal(resJson.ok, true);
      if (resJson.ok) {
        assert.equal(new TextDecoder().decode(resJson.call.args), '{"to":"alice","amount":42}');
        assert.equal(resJson.call.valueAtoms, 0n);
        assert.equal(resJson.call.gasLimit, undefined);
      }
    });

    it("rejects invalid PRO-21 addresses, bad checksums, legacy hex on mainnet/testnet, and wrong chain prefix", () => {
      // Bad checksum
      const corrupted =
        TESTNET_CONTRACT_A.slice(0, -4) +
        (TESTNET_CONTRACT_A.slice(-4, -3) === "a" ? "b" : "a") +
        TESTNET_CONTRACT_A.slice(-3);

      const badChecksum = validateBatchCallDraft(
        { ...createEmptyBatchCallDraft("bad1"), contract: corrupted, method: "ping" },
        CHAIN_IDS.TESTNET,
      );
      assert.equal(badChecksum.ok, false);
      if (!badChecksum.ok) {
        assert.equal(badChecksum.errors[0]?.field, "contract");
      }

      // Legacy hex rejected on testnet
      const legacyHex = validateBatchCallDraft(
        {
          ...createEmptyBatchCallDraft("bad2"),
          contract: "0x" + "11".repeat(32),
          method: "ping",
        },
        CHAIN_IDS.TESTNET,
      );
      assert.equal(legacyHex.ok, false);

      // Testnet tknc...dag rejected on mainnet
      const wrongChain = validateBatchCallDraft(
        {
          ...createEmptyBatchCallDraft("bad3"),
          contract: TESTNET_CONTRACT_A,
          method: "ping",
        },
        CHAIN_IDS.MAINNET,
      );
      assert.equal(wrongChain.ok, false);
    });

    it("validates hex/JSON args, value bounds, and gasLimit bounds", () => {
      assert.equal(parseBatchCallArgs("", "hex").ok, true);
      assert.equal(parseBatchCallArgs("0x", "hex").ok, true);
      assert.equal(parseBatchCallArgs("abc", "hex").ok, false);
      assert.equal(parseBatchCallArgs("0xzz", "hex").ok, false);

      assert.equal(parseBatchCallArgs("", "json").ok, true);
      assert.equal(parseBatchCallArgs("{bad json", "json").ok, false);

      const badNumbers = validateBatchCallDraft(
        {
          id: "n1",
          contract: MAINNET_CONTRACT_A,
          method: "",
          argsFormat: "hex",
          argsInput: "0x1",
          valueAtoms: "-5",
          gasLimit: "0",
        },
        CHAIN_IDS.MAINNET,
      );
      assert.equal(badNumbers.ok, false);
      if (!badNumbers.ok) {
        const fields = new Set(badNumbers.errors.map((e) => e.field));
        assert.equal(fields.has("method"), true);
        assert.equal(fields.has("args"), true);
        assert.equal(fields.has("valueAtoms"), true);
        assert.equal(fields.has("gasLimit"), true);
      }

      const hugeGas = validateBatchCallDraft(
        {
          id: "n2",
          contract: MAINNET_CONTRACT_A,
          method: "run",
          argsFormat: "hex",
          argsInput: "",
          gasLimit: (MAX_TX_GAS_LIMIT + 1n).toString(),
        },
        CHAIN_IDS.MAINNET,
      );
      assert.equal(hugeGas.ok, false);
    });

    it("reorders batch calls immutably", () => {
      const items = ["a", "b", "c"];
      assert.deepEqual(reorderBatchCalls(items, 0, 2), ["b", "c", "a"]);
      assert.deepEqual(reorderBatchCalls(items, 2, 1), ["a", "c", "b"]);
      assert.deepEqual(reorderBatchCalls(items, -1, 1), ["a", "b", "c"]);
      assert.deepEqual(items, ["a", "b", "c"]);
    });
  });

  describe("previewBatchContractCalls", () => {
    it("rejects empty batch fail-closed without performing any RPC calls", async () => {
      const { client, counts } = makeMockClient();
      await assert.rejects(
        () => previewBatchContractCalls(client, [], { chainId: CHAIN_IDS.TESTNET }),
        RangeError,
      );
      assert.equal(counts.estimateFee, 0);
      assert.equal(counts.getNonce, 0);
      assert.equal(counts.call, 0);
    });

    it("rejects invalid draft fail-closed before any RPC I/O", async () => {
      const { client, counts } = makeMockClient();
      const drafts: BatchCallDraft[] = [
        {
          id: "c1",
          contract: TESTNET_CONTRACT_A,
          method: "transfer",
          argsFormat: "hex",
          argsInput: "0x01",
        },
        {
          id: "c2",
          contract: "not-a-valid-address",
          method: "mint",
          argsFormat: "hex",
          argsInput: "",
        },
      ];
      await assert.rejects(
        () => previewBatchContractCalls(client, drafts, { chainId: CHAIN_IDS.TESTNET }),
        /Call #2 \(contract\)/,
      );
      assert.equal(counts.estimateFee, 0);
      assert.equal(counts.getNonce, 0);
      assert.equal(counts.call, 0);
    });

    it("aggregates multi-call estimation and dry-run results with sequential nonces", async () => {
      const { client, counts } = makeMockClient({
        feeRate: 250n,
        nonce: 10n,
        onCall: async (_method, _params, idx) => (idx === 0 ? "0x0102" : "0x"),
      });

      const drafts: BatchCallDraft[] = [
        {
          id: "call-1",
          contract: TESTNET_CONTRACT_A,
          method: "token_transfer",
          argsFormat: "hex",
          argsInput: "0xaabbccdd",
          valueAtoms: "1000000000", // 1 KVNC
          gasLimit: "120000",
        },
        {
          id: "call-2",
          contract: TESTNET_CONTRACT_B,
          method: "vault_claim",
          argsFormat: "json",
          argsInput: '{"id":1}',
          valueAtoms: "250000000", // 0.25 KVNC
          gasLimit: "80000",
        },
      ];

      const preview = await previewBatchContractCalls(client, drafts, {
        sender: TESTNET_SENDER,
        chainId: CHAIN_IDS.TESTNET,
      });

      // Single estimateFee + single getNonce + 2 dry-run calls
      assert.equal(counts.estimateFee, 1);
      assert.equal(counts.getNonce, 1);
      assert.equal(counts.call, 2);

      assert.equal(preview.totalCalls, 2);
      assert.equal(preview.passedCount, 2);
      assert.equal(preview.revertedCount, 0);
      assert.equal(preview.allSucceeded, true);
      assert.equal(preview.startNonce, 10n);
      assert.equal(preview.feeRatePerByte, 250n);
      assert.equal(preview.chainId, CHAIN_IDS.TESTNET);

      // Per-call checks
      assert.equal(preview.calls[0]?.nonce, 10n);
      assert.equal(preview.calls[1]?.nonce, 11n);
      assert.equal(preview.calls[0]?.gasLimit, 120_000n);
      assert.equal(preview.calls[1]?.gasLimit, 80_000n);
      assert.equal(preview.calls[0]?.dryRun.status, "success");
      assert.equal(preview.calls[1]?.dryRun.status, "success");
      if (preview.calls[0]?.dryRun.status === "success") {
        assert.equal(preview.calls[0].dryRun.rawHex, "0x0102");
        assert.match(preview.calls[0].dryRun.returnSummary, /2 bytes/);
      }
      if (preview.calls[1]?.dryRun.status === "success") {
        assert.match(preview.calls[1].dryRun.returnSummary, /0 bytes returned/);
      }

      // Aggregate checks
      const sumSize = preview.calls.reduce((acc, c) => acc + c.estimatedTxSize, 0);
      const sumFee = preview.calls.reduce((acc, c) => acc + c.marginedFeeAtoms, 0n);
      assert.equal(preview.totalEstimatedTxSize, sumSize);
      assert.equal(preview.totalFeeAtoms, sumFee);
      assert.equal(preview.totalGasLimit, 200_000n);
      assert.equal(preview.totalValueAtoms, 1_250_000_000n);
      assert.equal(preview.totalValueKvnc, "1.25");
      assert.equal(preview.totalCostAtoms, sumFee + 1_250_000_000n);
    });

    it("handles partial reverts cleanly without aborting remaining dry-run calls", async () => {
      const { client } = makeMockClient({
        feeRate: 100n,
        nonce: 3n,
        onCall: async (_method, _params, idx) => {
          if (idx === 1) {
            throw new Error("execution reverted: insufficient allowance");
          }
          return "0xdead";
        },
      });

      const drafts: BatchCallDraft[] = [
        {
          id: "c1",
          contract: TESTNET_CONTRACT_A,
          method: "approve",
          argsFormat: "hex",
          argsInput: "0x01",
        },
        {
          id: "c2",
          contract: TESTNET_CONTRACT_B,
          method: "transfer_from",
          argsFormat: "hex",
          argsInput: "0x02",
        },
        {
          id: "c3",
          contract: TESTNET_CONTRACT_A,
          method: "balance_of",
          argsFormat: "hex",
          argsInput: "0x03",
        },
      ];

      const preview = await previewBatchContractCalls(client, drafts, {
        sender: TESTNET_SENDER,
        chainId: CHAIN_IDS.TESTNET,
      });

      assert.equal(preview.totalCalls, 3);
      assert.equal(preview.passedCount, 2);
      assert.equal(preview.revertedCount, 1);
      assert.equal(preview.allSucceeded, false);

      assert.equal(preview.calls[0]?.dryRun.status, "success");
      assert.equal(preview.calls[1]?.dryRun.status, "reverted");
      if (preview.calls[1]?.dryRun.status === "reverted") {
        assert.match(preview.calls[1].dryRun.revertReason, /insufficient allowance/);
      }
      assert.equal(preview.calls[2]?.dryRun.status, "success");
    });

    it("computes lossless bigint KVNC totals beyond Number.MAX_SAFE_INTEGER", async () => {
      // Use values > 2^53 - 1 (9_007_199_254_740_991) to prove zero float precision loss.
      const largeValue1 = 10_000_000_000_000_001n; // 10,000,000.000000001 KVNC
      const largeValue2 = 20_000_000_000_000_002n; // 20,000,000.000000002 KVNC
      const highFeeRate = 10_000_000_000_001n; // atoms/byte

      const { client } = makeMockClient({
        feeRate: highFeeRate,
        nonce: 0n,
      });

      const drafts: BatchCallDraft[] = [
        {
          id: "big-1",
          contract: MAINNET_CONTRACT_A,
          method: "deposit",
          argsFormat: "hex",
          argsInput: "0x01",
          valueAtoms: largeValue1.toString(),
          gasLimit: "100000",
        },
        {
          id: "big-2",
          contract: MAINNET_CONTRACT_B,
          method: "deposit",
          argsFormat: "hex",
          argsInput: "0x02",
          valueAtoms: largeValue2.toString(),
          gasLimit: "100000",
        },
      ];

      const preview = await previewBatchContractCalls(client, drafts, {
        chainId: CHAIN_IDS.MAINNET,
        startNonce: 0n,
      });

      assert.equal(preview.totalValueAtoms, 30_000_000_000_000_003n);
      assert.equal(preview.totalValueKvnc, "30000000.000000003");

      const expectedTotalFee =
        preview.calls[0]!.marginedFeeAtoms + preview.calls[1]!.marginedFeeAtoms;
      assert.equal(preview.totalFeeAtoms, expectedTotalFee);
      assert.equal(preview.totalCostAtoms, expectedTotalFee + 30_000_000_000_000_003n);
      // Verify trailing fractional precision is preserved in totalCostKvnc
      assert.equal(preview.totalCostAtoms > BigInt(Number.MAX_SAFE_INTEGER), true);
      assert.equal(
        preview.totalCostKvnc.endsWith(
          (preview.totalCostAtoms % 1_000_000_000n)
            .toString()
            .padStart(9, "0")
            .replace(/0+$/, ""),
        ),
        true,
      );
    });
  });
});
