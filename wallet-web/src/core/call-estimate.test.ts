import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EstimateAndBuildCallClient } from "kovanica-sdk";
import { encodeAddress } from "./address.ts";
import { bytesToHex, hexToBytes } from "./bytes.ts";
import {
  computeCallWireSize,
  DEFAULT_FEE_SAFETY_MARGIN_BPS,
  estimateContractCallBatchPreview,
  estimateContractCallPreview,
  formatBatchCallEstimateSummary,
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

    const batchRows = formatBatchCallEstimateSummary({
      calls: [
        {
          estimatedTxSize: 284,
          feeRatePerByte: 100n,
          marginedFee: 34_080n,
          feeMarginBps: 12_000,
          gasLimit: 100_000n,
          nonce: 10n,
          chainId: 2,
        },
        {
          estimatedTxSize: 316,
          feeRatePerByte: 100n,
          marginedFee: 37_920n,
          feeMarginBps: 12_000,
          gasLimit: 150_000n,
          nonce: 11n,
          chainId: 2,
        },
        {
          estimatedTxSize: 250,
          feeRatePerByte: 100n,
          marginedFee: 30_000n,
          feeMarginBps: 12_000,
          gasLimit: 120_000n,
          nonce: 12n,
          chainId: 2,
        },
      ],
      totalEstimatedTxSize: 850,
      totalMarginedFee: 102_000n,
      totalGasLimit: 370_000n,
      feeRatePerByte: 100n,
      startNonce: 10n,
      chainId: 2,
    });

    assert.deepEqual(
      batchRows.map((r) => r.label),
      [
        "Batch size",
        "Total wire size",
        "Fee rate",
        "Total margined fee (+20%)",
        "Total gas limit",
        "Nonce range",
      ],
    );
    assert.equal(batchRows[0]?.value, "3 calls");
    assert.equal(batchRows[1]?.value, "850 bytes");
    assert.equal(batchRows[2]?.value, "100 atoms/byte");
    assert.ok(batchRows[3]?.value.includes("102,000 atoms"));
    assert.equal(batchRows[4]?.value, "370,000");
    assert.equal(batchRows[5]?.value, "10..12");
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

  it("estimates a multi-call batch with sequential nonces, single parallel RPC round-trip, and aggregate totals", async () => {
    const nameCall = buildContractCall({
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
      name: "batch.kvnc",
      relayEndpoints: ["127.0.0.1:9000"],
    });
    const nftCall = buildContractCall({
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
      tokenId: 7n,
      tokenUri: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    });
    const escrowCall = buildContractCall({
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
      amountAtoms: 5_000_000n,
      tokenUnits: null,
      txId: null,
      callDataHex: "",
      owners: `${senderAddr} ${bobAddr}`,
      threshold: 2,
      deadline: 1800000000n,
    });

    let estimateFeeCalls = 0;
    let getNonceCalls = 0;
    const feeRate = 80n;
    const baseNonce = 42n;

    const trackingClient: EstimateAndBuildCallClient = {
      async estimateFee() {
        estimateFeeCalls += 1;
        return feeRate;
      },
      async getNonce(address: string) {
        getNonceCalls += 1;
        assert.equal(address, senderAddr);
        return baseNonce;
      },
    };

    const batchInputs = [
      {
        contract: contractAddr,
        method: nameCall.method,
        args: nameCall.args,
        valueAtoms: 0n,
        gasLimit: 100_000n,
      },
      {
        contract: contractAddr,
        method: nftCall.method,
        args: nftCall.args,
        valueAtoms: 0n,
        gasLimit: 150_000n,
      },
      {
        contract: contractAddr,
        method: escrowCall.method,
        args: escrowCall.args,
        valueAtoms: 0n,
        // omit gasLimit to test +20% default gas safety margin (100_000n -> 120_000n)
      },
    ];

    const batchPreview = await estimateContractCallBatchPreview(trackingClient, batchInputs, {
      sender: senderAddr,
      chainId: 2,
    });

    assert.equal(estimateFeeCalls, 1, "estimateFee should be called once for the entire batch");
    assert.equal(getNonceCalls, 1, "getNonce should be called once for the entire batch");

    assert.equal(batchPreview.calls.length, 3);
    assert.equal(batchPreview.feeRatePerByte, feeRate);
    assert.equal(batchPreview.startNonce, baseNonce);
    assert.equal(batchPreview.chainId, 2);

    const expectedGasLimits = [100_000n, 150_000n, 120_000n];
    let expectedTotalSize = 0;
    let expectedTotalFee = 0n;
    let expectedTotalGas = 0n;

    for (let i = 0; i < batchInputs.length; i++) {
      const item = batchInputs[i]!;
      const resolvedGas = expectedGasLimits[i]!;
      const expectedSize = computeCallWireSize({
        contract: contractAddr,
        method: item.method,
        args: item.args,
        valueAtoms: 0n,
        gasLimit: resolvedGas,
        chainId: 2,
      });
      const expectedBaseFee = feeRate * BigInt(expectedSize);
      const expectedMarginedFee = (expectedBaseFee * 12_000n + 9_999n) / 10_000n;

      const callPreview = batchPreview.calls[i]!;
      assert.equal(callPreview.estimatedTxSize, expectedSize);
      assert.equal(callPreview.feeRatePerByte, feeRate);
      assert.equal(callPreview.feeMarginBps, DEFAULT_FEE_SAFETY_MARGIN_BPS);
      assert.equal(callPreview.marginedFee, expectedMarginedFee);
      assert.equal(callPreview.gasLimit, resolvedGas);
      assert.equal(callPreview.nonce, baseNonce + BigInt(i));
      assert.equal(callPreview.chainId, 2);

      expectedTotalSize += expectedSize;
      expectedTotalFee += expectedMarginedFee;
      expectedTotalGas += resolvedGas;
    }

    assert.equal(batchPreview.totalEstimatedTxSize, expectedTotalSize);
    assert.equal(batchPreview.totalMarginedFee, expectedTotalFee);
    assert.equal(batchPreview.totalGasLimit, expectedTotalGas);
  });

  it("supports explicit startNonce and feeRatePerByte overrides without RPC calls and enforces maxTotalFee", async () => {
    let rpcCalled = false;
    const failIfCalledClient: EstimateAndBuildCallClient = {
      async estimateFee() {
        rpcCalled = true;
        return 100n;
      },
      async getNonce() {
        rpcCalled = true;
        return 0n;
      },
    };

    const batch = await estimateContractCallBatchPreview(
      failIfCalledClient,
      [
        {
          contract: contractAddr,
          method: "token_transfer",
          args: new Uint8Array([1, 2, 3, 4]),
          valueAtoms: 0n,
          gasLimit: 100_000n,
        },
        {
          contract: contractAddr,
          method: "token_transfer",
          args: new Uint8Array([5, 6, 7, 8]),
          valueAtoms: 0n,
          gasLimit: 100_000n,
        },
      ],
      {
        startNonce: 10n,
        feeRatePerByte: 50n,
        chainId: 2,
      },
    );

    assert.equal(rpcCalled, false);
    assert.equal(batch.startNonce, 10n);
    assert.equal(batch.calls[0]?.nonce, 10n);
    assert.equal(batch.calls[1]?.nonce, 11n);
    assert.equal(batch.totalMarginedFee, batch.calls[0]!.marginedFee + batch.calls[1]!.marginedFee);

    await assert.rejects(
      () =>
        estimateContractCallBatchPreview(failIfCalledClient, [], {
          chainId: 2,
        }),
      /non-empty/i,
    );

    await assert.rejects(
      () =>
        estimateContractCallBatchPreview(
          failIfCalledClient,
          [
            {
              contract: contractAddr,
              method: "token_transfer",
              args: new Uint8Array([1, 2]),
              valueAtoms: 0n,
              gasLimit: 100_000n,
            },
          ],
          {
            startNonce: 1n,
            feeRatePerByte: 100n,
            maxTotalFee: 100n,
            chainId: 2,
          },
        ),
      /maxTotalFee/i,
    );
  });
});
