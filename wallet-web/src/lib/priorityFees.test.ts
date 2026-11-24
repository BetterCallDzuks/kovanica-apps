import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_RBF_BUMP_BPS,
  MAX_RBF_BUMP_BPS,
  MIN_RBF_BUMP_BPS,
  RBF_BUMP_PRESETS_BPS,
  TRANSFER_TX_WIRE_SIZE,
  fetchPriorityFeeTiers,
  formatBumpBpsPercent,
  previewRbfBump,
  selectFeeTier,
  type PriorityFeeTierName,
  type PriorityFeeTiersClient,
  type PriorityFeeTiersEstimate,
} from "./priorityFees.ts";

function makeCallClient(payload: Record<string, unknown>): PriorityFeeTiersClient {
  return {
    async call<TResult = unknown>(method: string): Promise<TResult> {
      assert.equal(method, "kovanica_mempoolStats");
      return payload as TResult;
    },
  };
}

function makeStatsClient(payload: Record<string, unknown>): PriorityFeeTiersClient {
  return {
    async getMempoolStats() {
      return payload;
    },
  };
}

describe("priorityFees — fetchPriorityFeeTiers & selectFeeTier", () => {
  it("computes monotonic slow/standard/fast tiers for low congestion mempool", async () => {
    const client = makeCallClient({
      pending_count: 12,
      total_bytes: 2_400,
      min_fee_per_byte: "10",
      p50_fee_per_byte: "20",
      p90_fee_per_byte: "50",
      max_fee_per_byte: "80",
    });

    const tiers = await fetchPriorityFeeTiers(client, { txSizeBytes: TRANSFER_TX_WIRE_SIZE });

    assert.equal(tiers.source, "mempool");
    assert.equal(tiers.congestionLevel, "low");
    assert.equal(tiers.pendingCount, 12);

    const slow = selectFeeTier(tiers, "slow");
    const standard = selectFeeTier(tiers, "standard");
    const fast = selectFeeTier(tiers, "fast");

    assert.equal(slow.tier, "slow");
    assert.equal(standard.tier, "standard");
    assert.equal(fast.tier, "fast");

    assert.ok(slow.feeAtoms <= standard.feeAtoms);
    assert.ok(standard.feeAtoms <= fast.feeAtoms);

    assert.equal(slow.feePerByte, 10n);
    assert.equal(slow.feeAtoms, 10n * BigInt(TRANSFER_TX_WIRE_SIZE));
    assert.equal(standard.feePerByte, 24n); // 20 * 1.2
    assert.equal(standard.feeAtoms, 24n * BigInt(TRANSFER_TX_WIRE_SIZE));
    assert.equal(fast.feePerByte, 60n); // 50 * 1.2
    assert.equal(fast.feeAtoms, 60n * BigInt(TRANSFER_TX_WIRE_SIZE));

    assert.equal(slow.estimatedInclusionBlocks, 3);
    assert.equal(standard.estimatedInclusionBlocks, 2);
    assert.equal(fast.estimatedInclusionBlocks, 1);
  });

  it("classifies moderate (>= 50) and high (>= 200) congestion levels accurately", async () => {
    const moderateClient = makeStatsClient({
      pendingCount: 75,
      totalBytes: 15_000,
      minFeePerByte: 5n,
      p50FeePerByte: 15n,
      p90FeePerByte: 40n,
      maxFeePerByte: 60n,
    });
    const moderate = await fetchPriorityFeeTiers(moderateClient);
    assert.equal(moderate.congestionLevel, "moderate");
    assert.equal(moderate.slow.estimatedInclusionBlocks, 6);
    assert.equal(moderate.standard.estimatedInclusionBlocks, 3);
    assert.equal(moderate.fast.estimatedInclusionBlocks, 1);

    const highClient = makeStatsClient({
      pendingCount: 250,
      totalBytes: 50_000,
      minFeePerByte: 25n,
      p50FeePerByte: 100n,
      p90FeePerByte: 300n,
      maxFeePerByte: 500n,
    });
    const high = await fetchPriorityFeeTiers(highClient);
    assert.equal(high.congestionLevel, "high");
    assert.equal(high.slow.estimatedInclusionBlocks, 12);
    assert.equal(high.standard.estimatedInclusionBlocks, 5);
    assert.equal(high.fast.estimatedInclusionBlocks, 2);
  });

  it("falls back cleanly when mempool is empty", async () => {
    const emptyClient = makeCallClient({
      pending_count: 0,
      total_bytes: 0,
      min_fee_per_byte: null,
      p50_fee_per_byte: null,
      p90_fee_per_byte: null,
      max_fee_per_byte: null,
    });

    const tiers = await fetchPriorityFeeTiers(emptyClient, {
      txSizeBytes: 200,
      fallbackBaseFeePerByte: 2n,
    });

    assert.equal(tiers.source, "fallback");
    assert.equal(tiers.congestionLevel, "low");
    assert.equal(tiers.pendingCount, 0);
    assert.equal(tiers.slow.feePerByte, 2n);
    assert.equal(tiers.slow.feeAtoms, 400n);
    assert.ok(tiers.slow.feeAtoms <= tiers.standard.feeAtoms);
    assert.ok(tiers.standard.feeAtoms <= tiers.fast.feeAtoms);
  });

  it("rejects invalid RPC URLs and invalid client/tier inputs", async () => {
    await assert.rejects(() => fetchPriorityFeeTiers(""), RangeError);
    await assert.rejects(() => fetchPriorityFeeTiers("   "), RangeError);
    await assert.rejects(() => fetchPriorityFeeTiers("not-a-url"), RangeError);
    await assert.rejects(() => fetchPriorityFeeTiers("ftp://rpc.example.com"), RangeError);
    await assert.rejects(() => fetchPriorityFeeTiers("javascript:alert(1)"), RangeError);
    await assert.rejects(
      () => fetchPriorityFeeTiers(null as unknown as PriorityFeeTiersClient),
      TypeError,
    );

    const validClient = makeStatsClient({
      pendingCount: 0,
      totalBytes: 0,
      minFeePerByte: null,
      p50FeePerByte: null,
      p90FeePerByte: null,
      maxFeePerByte: null,
    });
    await assert.rejects(
      () => fetchPriorityFeeTiers(validClient, { txSizeBytes: 0 }),
      RangeError,
    );
    await assert.rejects(
      () => fetchPriorityFeeTiers(validClient, { txSizeBytes: -5 }),
      RangeError,
    );
    await assert.rejects(
      () => fetchPriorityFeeTiers(validClient, { txSizeBytes: 1.5 }),
      RangeError,
    );

    const tiers = await fetchPriorityFeeTiers(validClient);
    assert.throws(
      () => selectFeeTier(tiers, "turbo" as unknown as PriorityFeeTierName),
      RangeError,
    );
    assert.throws(
      () => selectFeeTier(null as unknown as PriorityFeeTiersEstimate, "standard"),
      TypeError,
    );
  });
});

describe("priorityFees — previewRbfBump & formatBumpBpsPercent", () => {
  it("computes default +15% and preset (+15% / +25% / +50%) bumps with KVNC strings", () => {
    assert.deepEqual([...RBF_BUMP_PRESETS_BPS], [1_500, 2_500, 5_000]);

    const def = previewRbfBump(1_000_000_000n); // 1 KVNC
    assert.equal(def.bumpBps, DEFAULT_RBF_BUMP_BPS);
    assert.equal(def.bumpPercentLabel, "+15%");
    assert.equal(def.previousFeeAtoms, 1_000_000_000n);
    assert.equal(def.deltaAtoms, 150_000_000n);
    assert.equal(def.bumpedFeeAtoms, 1_150_000_000n);
    assert.equal(def.previousFeeKvnc, "1");
    assert.equal(def.deltaKvnc, "0.15");
    assert.equal(def.bumpedFeeKvnc, "1.15");

    const p25 = previewRbfBump(1_000_000_000n, 2_500);
    assert.equal(p25.bumpPercentLabel, "+25%");
    assert.equal(p25.deltaAtoms, 250_000_000n);
    assert.equal(p25.bumpedFeeAtoms, 1_250_000_000n);
    assert.equal(p25.bumpedFeeKvnc, "1.25");

    const p50 = previewRbfBump(1_000_000_000n, 5_000);
    assert.equal(p50.bumpPercentLabel, "+50%");
    assert.equal(p50.deltaAtoms, 500_000_000n);
    assert.equal(p50.bumpedFeeAtoms, 1_500_000_000n);
    assert.equal(p50.bumpedFeeKvnc, "1.5");
  });

  it("strictly increases small fees (1n and 0n) without truncation", () => {
    const fromOne = previewRbfBump(1n);
    assert.equal(fromOne.previousFeeAtoms, 1n);
    assert.equal(fromOne.deltaAtoms, 1n);
    assert.equal(fromOne.bumpedFeeAtoms, 2n);
    assert.equal(fromOne.previousFeeKvnc, "0.000000001");
    assert.equal(fromOne.deltaKvnc, "0.000000001");
    assert.equal(fromOne.bumpedFeeKvnc, "0.000000002");

    const fromZero = previewRbfBump(0n, 2_500);
    assert.equal(fromZero.previousFeeAtoms, 0n);
    assert.equal(fromZero.deltaAtoms, 1n);
    assert.equal(fromZero.bumpedFeeAtoms, 1n);
    assert.equal(fromZero.bumpedFeeKvnc, "0.000000001");
  });

  it("preserves exact bigint precision for fees > Number.MAX_SAFE_INTEGER", () => {
    // 10_000_000_000_000_000_001n > Number.MAX_SAFE_INTEGER (9_007_199_254_740_991)
    const hugeFee = 10_000_000_000_000_000_001n;
    const res = previewRbfBump(hugeFee, 1_500);

    // ceil(10_000_000_000_000_000_001 * 1500 / 10000) = 1_500_000_000_000_000_001n
    const expectedDelta = 1_500_000_000_000_000_001n;
    const expectedBumped = hugeFee + expectedDelta;

    assert.equal(res.previousFeeAtoms, hugeFee);
    assert.equal(res.deltaAtoms, expectedDelta);
    assert.equal(res.bumpedFeeAtoms, expectedBumped);
    assert.equal(res.previousFeeKvnc, "10000000000.000000001");
    assert.equal(res.deltaKvnc, "1500000000.000000001");
    assert.equal(res.bumpedFeeKvnc, "11500000000.000000002");
  });

  it("supports custom minBumpAtoms and fractional bps formatting", () => {
    const res = previewRbfBump(100n, 1_250, { minBumpAtoms: 50n });
    assert.equal(res.bumpPercentLabel, "+12.5%");
    assert.equal(res.deltaAtoms, 50n);
    assert.equal(res.bumpedFeeAtoms, 150n);
    assert.equal(formatBumpBpsPercent(125), "+1.25%");
  });

  it("rejects invalid RBF bump inputs fail-closed", () => {
    assert.throws(() => previewRbfBump(-1n), RangeError);
    assert.throws(() => previewRbfBump(100 as unknown as bigint), TypeError);
    assert.throws(() => previewRbfBump(100n, MIN_RBF_BUMP_BPS - 1), RangeError);
    assert.throws(() => previewRbfBump(100n, MAX_RBF_BUMP_BPS + 1), RangeError);
    assert.throws(() => previewRbfBump(100n, 1_500.5), RangeError);
    assert.throws(() => previewRbfBump(100n, Number.NaN), RangeError);
    assert.throws(() => previewRbfBump(100n, 1_500, { minBumpAtoms: 0n }), RangeError);
    assert.throws(() => formatBumpBpsPercent(-100), RangeError);
  });
});
