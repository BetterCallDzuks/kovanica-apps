import { useCallback, useEffect, useState } from "react";
import { formatAtoms, parseAtoms } from "@/core/format";
import {
  DEFAULT_RBF_BUMP_BPS,
  PRIORITY_FEE_TIER_KEYS,
  RBF_BUMP_PRESETS_BPS,
  TRANSFER_TX_WIRE_SIZE,
  fetchPriorityFeeTiers,
  formatBumpBpsPercent,
  previewRbfBump,
  selectFeeTier,
  type MempoolCongestionLevel,
  type PriorityFeeTierName,
  type PriorityFeeTiersEstimate,
  type RbfFeeBumpPreview,
} from "@/lib/priorityFees";
import { createPriorityFeeTiersClient } from "@/services/rpc";

const TIER_LABELS: Record<PriorityFeeTierName, string> = {
  slow: "Slow",
  standard: "Standard",
  fast: "Fast",
};

const CONGESTION_BADGE: Record<
  MempoolCongestionLevel,
  { label: string; className: string }
> = {
  low: {
    label: "Low congestion",
    className: "border-sage/40 bg-sage/10 text-sage",
  },
  moderate: {
    label: "Moderate congestion",
    className: "border-copper/40 bg-copper/10 text-copper",
  },
  high: {
    label: "High congestion",
    className: "border-clay/40 bg-clay/10 text-clay",
  },
};

function formatInclusionBlocks(blocks: number): string {
  return `~${blocks} ${blocks === 1 ? "block" : "blocks"}`;
}

export function PriorityFeeSelector({
  rpcUrl,
  online,
  currentFeeAtoms,
  onSelectFeeAtoms,
  txSizeBytes = TRANSFER_TX_WIRE_SIZE,
  quoteTick = 0,
}: {
  rpcUrl: string;
  online: boolean;
  currentFeeAtoms: bigint | null;
  onSelectFeeAtoms: (feeAtoms: bigint) => void;
  txSizeBytes?: number | bigint;
  quoteTick?: number;
}) {
  const [tiers, setTiers] = useState<PriorityFeeTiersEstimate | null>(null);
  const [selectedTier, setSelectedTier] = useState<PriorityFeeTierName | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showRbf, setShowRbf] = useState(false);
  const [bumpBps, setBumpBps] = useState<number>(DEFAULT_RBF_BUMP_BPS);
  const [previousFeeInput, setPreviousFeeInput] = useState("");

  const loadTiers = useCallback(
    async (isCancelled?: () => boolean) => {
      if (!online || !rpcUrl.trim()) {
        setTiers(null);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const client = createPriorityFeeTiersClient(rpcUrl);
        const estimate = await fetchPriorityFeeTiers(client, { txSizeBytes });
        if (isCancelled?.()) return;
        setTiers(estimate);
      } catch (err) {
        if (isCancelled?.()) return;
        setError(
          err instanceof Error ? err.message : "Could not load mempool fee tiers",
        );
      } finally {
        if (!isCancelled?.()) {
          setLoading(false);
        }
      }
    },
    [online, rpcUrl, txSizeBytes],
  );

  useEffect(() => {
    let cancelled = false;
    void loadTiers(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadTiers, quoteTick]);

  useEffect(() => {
    if (quoteTick === 0) return;
    setSelectedTier(null);
  }, [quoteTick]);

  function handleTierPick(tierKey: PriorityFeeTierName) {
    if (!tiers) return;
    const picked = selectFeeTier(tiers, tierKey);
    setSelectedTier(tierKey);
    onSelectFeeAtoms(picked.feeAtoms);
  }

  const effectivePreviousFeeAtoms = previousFeeInput.trim()
    ? parseAtoms(previousFeeInput)
    : currentFeeAtoms;

  let rbfPreview: RbfFeeBumpPreview | null = null;
  let rbfError: string | null = null;
  if (showRbf) {
    if (previousFeeInput.trim() && effectivePreviousFeeAtoms == null) {
      rbfError = "Enter a valid non-negative integer fee in atoms.";
    } else if (effectivePreviousFeeAtoms != null) {
      try {
        rbfPreview = previewRbfBump(effectivePreviousFeeAtoms, bumpBps);
      } catch (err) {
        rbfError =
          err instanceof Error ? err.message : "Could not calculate RBF bump";
      }
    }
  }

  const badge = tiers ? CONGESTION_BADGE[tiers.congestionLevel] : null;

  return (
    <div className="grid gap-3 rounded-2xl border border-line bg-surface/60 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-paper">Priority fee</span>
          {badge && tiers ? (
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
            >
              {badge.label}
              {` · ${tiers.pendingCount} pending`}
            </span>
          ) : null}
          {tiers?.source === "fallback" ? (
            <span className="text-xs text-muted">Fallback estimate</span>
          ) : null}
        </div>
        <button
          type="button"
          className="text-xs text-copper disabled:opacity-40"
          disabled={loading || !online}
          onClick={() => void loadTiers()}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {tiers ? (
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Priority fee tiers">
          {PRIORITY_FEE_TIER_KEYS.map((tierKey) => {
            const tier = selectFeeTier(tiers, tierKey);
            const active =
              selectedTier === tierKey ||
              (selectedTier === null && currentFeeAtoms === tier.feeAtoms);
            return (
              <button
                key={tierKey}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => handleTierPick(tierKey)}
                className={`grid gap-0.5 rounded-xl border p-2.5 text-left transition-colors ${
                  active
                    ? "border-copper bg-copper/15 text-paper"
                    : "border-line bg-ink/80 text-paper hover:border-copper/50"
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-medium">{TIER_LABELS[tierKey]}</span>
                  <span className="text-[11px] text-muted">
                    {formatInclusionBlocks(tier.estimatedInclusionBlocks)}
                  </span>
                </div>
                <span className="font-mono text-xs tabular-nums text-paper">
                  {tier.feeKvnc} KVNC
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  {formatAtoms(tier.feeAtoms)} atoms
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted">
          {!online
            ? "Connect to a node to load live mempool fee tiers."
            : loading
              ? "Loading live mempool fee tiers…"
              : error
                ? `Mempool fee tiers unavailable (${error}).`
                : "Mempool fee tiers unavailable."}
        </p>
      )}

      <div className="border-t border-line/70 pt-2.5">
        <button
          type="button"
          className="text-left text-xs font-medium text-copper"
          onClick={() => setShowRbf((prev) => !prev)}
        >
          {showRbf ? "Hide RBF fee bump preview" : "RBF fee bump preview"}
        </button>

        {showRbf ? (
          <div className="mt-2.5 grid gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              {RBF_BUMP_PRESETS_BPS.map((presetBps) => {
                const isSelected = bumpBps === presetBps;
                return (
                  <button
                    key={presetBps}
                    type="button"
                    onClick={() => setBumpBps(presetBps)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium tabular-nums transition-colors ${
                      isSelected
                        ? "border-copper bg-copper text-copper-ink"
                        : "border-line bg-ink text-paper hover:border-copper/50"
                    }`}
                  >
                    {formatBumpBpsPercent(presetBps)}
                  </button>
                );
              })}
            </div>

            <label className="grid gap-1 text-xs text-muted">
              Previous fee atoms (optional override)
              <input
                className="min-h-9 rounded-xl border border-line bg-ink px-3 font-mono text-xs tabular-nums text-paper"
                value={previousFeeInput}
                placeholder={currentFeeAtoms != null ? currentFeeAtoms.toString() : "Enter atoms"}
                onChange={(e) => setPreviousFeeInput(e.target.value)}
              />
            </label>

            {rbfError ? <p className="text-xs text-clay">{rbfError}</p> : null}

            {rbfPreview ? (
              <div className="grid gap-1.5 rounded-xl border border-line bg-ink/80 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2 text-muted">
                  <span>Previous fee</span>
                  <span className="font-mono tabular-nums text-paper">
                    {rbfPreview.previousFeeKvnc} KVNC ({formatAtoms(rbfPreview.previousFeeAtoms)} atoms)
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 text-muted">
                  <span>Bump ({rbfPreview.bumpPercentLabel})</span>
                  <span className="font-mono tabular-nums text-sage">
                    +{rbfPreview.deltaKvnc} KVNC (+{formatAtoms(rbfPreview.deltaAtoms)} atoms)
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-line/70 pt-1.5 font-medium text-paper">
                  <span>Replacement fee</span>
                  <span className="font-mono tabular-nums">
                    {rbfPreview.bumpedFeeKvnc} KVNC ({formatAtoms(rbfPreview.bumpedFeeAtoms)} atoms)
                  </span>
                </div>
                <button
                  type="button"
                  className="mt-1 min-h-8 rounded-full border border-copper/60 bg-copper/15 px-3 text-xs font-medium text-copper hover:bg-copper/25"
                  onClick={() => {
                    setSelectedTier(null);
                    onSelectFeeAtoms(rbfPreview.bumpedFeeAtoms);
                  }}
                >
                  Apply bumped fee
                </button>
              </div>
            ) : !rbfError ? (
              <p className="text-xs text-muted">
                Select a fee tier or enter a previous fee in atoms to preview an RBF replacement bump.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
