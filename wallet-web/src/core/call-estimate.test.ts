import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EstimateAndBuildCallClient } from "kovanica-sdk";
import { encodeAddress } from "./address.ts";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import {
  computeCallWireSize,
  DEFAULT_FEE_SAFETY_MARGIN_BPS,
  estimateContractCallPreview,
  formatCallEstimateSummary,
  formatSafetyMarginPercent,
} from "./call-estimate.ts";
import { buildContractCall } from "./contracts.ts";
import { encodeRawTransaction, publicKeyFromSeed, signTransaction } from "./tx.ts";

describe("contract call fee/gas & wire-size preview", () => {
  const seed = new Uint8Array(32).fill(0x42);
  const senderKey = publicKeyFromSeed(seed);
  const senderAddr = encodeAddress(senderKey);
  const contractBytes = new Uint8Array(32).fill(0x11);
  const contractAddr = encodeAddress(contractBytes);
  const bobBytes = new Uint8Array(32).fill(0x22);
  const bobAddr = encodeAddress(bobBytes);

  function mockClient(feeRate: bigint, nonce: bigint): EstimateAndBuildCallClient {
    return {
      async estimateFee() {
        return feeRate;
      },
      async getNonce() {
        return nonce;
      },
    };
  }

  it("matches exact serialized wire size byte-for-byte against signTransaction", () => {
    const call = buildContractCall({
      contract: "name",
      method: "name_register",
      chainId: 2,
      claimer: "",
      beneficiary: "",
      recipient: senderAddr,
      account: "",
      hash: "",
      secret: "",
      id: "",
      timelockMs: null,
      lockUntilMs: null,
      amountAtoms: null,
      tokenUnits: null,
      txId: null,
      callDataHex: "",
      name: "alice.kvnc",
      relayEndpoints: ["127.0.0.1:8000"],
    });

    const wireSize = computeCallWireSize({
      contract: contractAddr,
      method: call.method,
      args: call.args,
      valueAtoms: 0n,
      gasLimit: 100_000n,
      chainId: 2,
    });

    const signed = signTransaction(
      {
        sender: senderKey,
        nonce: 7n,
        fee: 100_000n,
        kind: {
          type: "call",
          contract: contractBytes,
          value: 0n,
          method: call.method,
          args: call.args,
          gasLimit: 100_000n,
        },
      },
      2,
      seed,
    );
    const actualBytes = hexToBytes(signed.raw);
    assert.equal(wireSize, actualBytes.length);

    // Also verify encodeRawTransaction produces identical byte length
    const reEncoded = encodeRawTransaction(
      {
        sender: senderKey,
        nonce: 7n,
        fee: 100_000n,
        kind: {
          type: "call",
          contract: contractBytes,
          value: 0n,
          method: call.method,
          args: call.args,
          gasLimit: 100_000n,
        },
      },
      signed.signature,
      hexToBytes(signed.hash),
    );
    assert.equal(wireSize, reEncoded.length / 2);
  });

  it("estimates wire size, fee rate, +20% margined fee, gas limit, and nonce for name, nft, and escrow calls", async () => {
    const cases = [
      buildContractCall({
        contract: "name",
        method: "name_register",
        chainId: 2,
        claimer: "",
        beneficiary: "",
        recipient: senderAddr,
        account: "",
        hash: "",
        secret: "",
        id: "",
        timelockMs: null,
        lockUntilMs: null,
        amountAtoms: null,
        tokenUnits: null,
        txId: null,
        callDataHex: "",
        name: "bob",
        relayEndpoints: ["127.0.0.1:9000"],
      }),
      buildContractCall({
        contract: "nft",
        method: "nft_mint",
        chainId: 2,
        claimer: "",
        beneficiary: "",
        recipient: bobAddr,
        account: "",
        hash: "",
        secret: "",
        id: "",
        timelockMs: null,
        lockUntilMs: null,
        amountAtoms: null,
        tokenUnits: null,
        txId: null,
        callDataHex: "",
        collection: bytesToHex(contractBytes),
        tokenId: 42n,
        tokenUri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      }),
      buildContractCall({
        contract: "escrow",
        method: "escrow_create",
        chainId: 2,
        claimer: "",
        beneficiary: "",
        recipient: "",
        account: "",
        hash: "",
        secret: "",
        id: "",
        timelockMs: null,
        lockUntilMs: null,
        amountAtoms: 10_000_000n,
        tokenUnits: null,
        txId: null,
        callDataHex: "",
        owners: `${senderAddr} ${bobAddr}`,
        threshold: 2,
        deadline: 1800000000n,
      }),
    ];

    const feeRate = 100n;
    const expectedNonce = 19n;

    for (const call of cases) {
      const preview = await estimateContractCallPreview(mockClient(feeRate, expectedNonce), {
        contract: contractAddr,
        method: call.method,
        args: call.args,
        valueAtoms: 0n,
        gasLimit: 100_000n,
        sender: senderAddr,
        chainId: 2,
      });

      const expectedSize = computeCallWireSize({
        contract: contractAddr,
        method: call.method,
        args: call.args,
        valueAtoms: 0n,
        gasLimit: 100_000n,
        chainId: 2,
      });
      const expectedBaseFee = feeRate * BigInt(expectedSize);
      const expectedMarginedFee = (expectedBaseFee * 12_000n + 9_999n) / 10_000n;

      assert.equal(preview.estimatedTxSize, expectedSize);
      assert.equal(preview.feeRatePerByte, feeRate);
      assert.equal(preview.feeMarginBps, DEFAULT_FEE_SAFETY_MARGIN_BPS);
      assert.equal(preview.marginedFee, expectedMarginedFee);
      assert.equal(preview.gasLimit, 100_000n);
      assert.equal(preview.nonce, expectedNonce);
      assert.equal(preview.chainId, 2);
    }
  });

  it("applies +20% safety margin to defaulted gas limit when gasLimit is omitted", async () => {
    const preview = await estimateContractCallPreview(mockClient(50n, 3n), {
      contract: contractAddr,
      method: "token_transfer",
      args: new Uint8Array([1, 2, 3, 4]),
      valueAtoms: 0n,
      sender: senderAddr,
      chainId: 2,
    });

    // SDK default gas is 100_000n, with +20% default gas safety margin => 120_000n
    assert.equal(preview.gasLimit, 120_000n);
    assert.equal(preview.nonce, 3n);
  });

  it("formats safety margin percentages and summary rows for UI display", () => {
    assert.equal(formatSafetyMarginPercent(12_000), "+20%");
    assert.equal(formatSafetyMarginPercent(10_000), "0%");
    assert.equal(formatSafetyMarginPercent(11_250), "+12.50%");

    const rows = formatCallEstimateSummary({
      estimatedTxSize: 284,
      feeRatePerByte: 100n,
      marginedFee: 34_080n,
      feeMarginBps: 12_000,
      gasLimit: 100_000n,
      nonce: 5n,
      chainId: 2,
    });

    assert.deepEqual(
      rows.map((r) => r.label),
      ["Estimated wire size", "Fee rate", "Margined fee (+20%)", "Gas limit", "Nonce"],
    );
    assert.equal(rows[0]?.value, "284 bytes");
    assert.equal(rows[1]?.value, "100 atoms/byte");
    assert.ok(rows[2]?.value.includes("34,080 atoms"));
    assert.equal(rows[3]?.value, "100,000");
    assert.equal(rows[4]?.value, "5");
  });

  it("rejects negative fee rates from RPC", async () => {
    await assert.rejects(
      () =>
        estimateContractCallPreview(mockClient(-1n, 0n), {
          contract: contractAddr,
          method: "token_transfer",
          args: new Uint8Array(),
          valueAtoms: 0n,
          gasLimit: 100_000n,
          sender: senderAddr,
          chainId: 2,
        }),
      /non-negative/i,
    );
  });
});
