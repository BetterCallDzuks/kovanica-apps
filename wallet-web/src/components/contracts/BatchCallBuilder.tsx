import { useEffect, useState } from "react";
import { CHAIN_IDS } from "kovanica-sdk";
import { formatSafetyMarginPercent } from "@/core/call-estimate";
import { formatAtoms } from "@/core/format";
import {
  createEmptyBatchCallDraft,
  previewBatchContractCalls,
  reorderBatchCalls,
  validateBatchCallDraft,
  type BatchCallArgsFormat,
  type BatchCallDraft,
  type BatchContractCallsPreview,
} from "@/lib/batchCalls";
import { presetById } from "@/lib/networks";
import { createBatchContractCallClient } from "@/services/rpc";
import { useNetwork } from "@/stores/network";

function shortenAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

export function BatchCallBuilder({
  senderAddress = "",
  watchOnly = false,
}: {
  senderAddress?: string;
  watchOnly?: boolean;
}) {
  const net = useNetwork();
  const resolvedChainId =
    net.probedChainId ?? presetById(net.presetId).expectedChainId ?? CHAIN_IDS.TESTNET;

  const [drafts, setDrafts] = useState<BatchCallDraft[]>(() => [createEmptyBatchCallDraft()]);
  const [fromAddress, setFromAddress] = useState(senderAddress);
  const [parallelDryRun, setParallelDryRun] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BatchContractCallsPreview | null>(null);

  useEffect(() => {
    if (senderAddress) {
      setFromAddress((current) => current || senderAddress);
    }
  }, [senderAddress]);

  function updateDraft(id: string, patch: Partial<BatchCallDraft>) {
    setDrafts((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setPreview(null);
    setError(null);
  }

  function addCall() {
    setDrafts((prev) => [...prev, createEmptyBatchCallDraft()]);
    setPreview(null);
    setError(null);
  }

  function removeCall(id: string) {
    setDrafts((prev) => {
      if (prev.length <= 1) return [createEmptyBatchCallDraft()];
      return prev.filter((item) => item.id !== id);
    });
    setPreview(null);
    setError(null);
  }

  function moveCall(index: number, delta: -1 | 1) {
    setDrafts((prev) => reorderBatchCalls(prev, index, index + delta));
    setPreview(null);
  }

  function clearAll() {
    setDrafts([createEmptyBatchCallDraft()]);
    setPreview(null);
    setError(null);
  }

  async function runEstimateAndDryRun() {
    setError(null);
    if (!net.online) {
      setError("The node is not responding, so batch estimation and dry-run cannot run.");
      return;
    }
    if (drafts.length === 0) {
      setError("Add at least one contract call before running a batch preview.");
      return;
    }

    setRunning(true);
    try {
      const client = createBatchContractCallClient(net.rpcUrl);
      const trimmedFrom = fromAddress.trim() || undefined;
      const result = await previewBatchContractCalls(client, drafts, {
        sender: trimmedFrom,
        from: trimmedFrom,
        startNonce: trimmedFrom ? undefined : (net.nonce ?? undefined),
        parallel: parallelDryRun,
        chainId: resolvedChainId,
      });
      setPreview(result);
    } catch (err) {
      setPreview(null);
      setError(
        err instanceof Error
          ? err.message
          : "Could not estimate and dry-run the contract call batch.",
      );
    } finally {
      setRunning(false);
    }
  }

  const firstNonce = preview?.startNonce ?? preview?.calls[0]?.nonce ?? null;
  const lastNonce =
    firstNonce != null && preview && preview.totalCalls > 0
      ? firstNonce + BigInt(preview.totalCalls - 1)
      : null;
  const nonceRangeLabel =
    firstNonce == null
      ? "auto"
      : preview && preview.totalCalls <= 1
        ? firstNonce.toString()
        : `${firstNonce.toString()}..${(lastNonce ?? firstNonce).toString()}`;

  return (
    <section
      className="rounded-3xl border border-line bg-ink px-4 py-4 text-sm"
      aria-label="Batch Contract Call Builder and Dry-Run Preview"
      data-testid="batch-call-builder"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium text-paper">Batch Contract Call Builder &amp; Dry-Run</h3>
          <p className="mt-1 text-xs text-muted">
            Compose multiple contract calls to preview sequential nonces, exact wire sizes, +20%
            margined fees, gas limits, and read-only simulation outcomes.
          </p>
        </div>
        <span className="rounded-full border border-sage/50 bg-sage/10 px-2.5 py-0.5 text-xs text-sage">
          {watchOnly ? "Watch-only safe · Read-only" : "Read-only simulation"}
        </span>
      </div>

      <div className="mt-3 grid gap-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="grid gap-1 text-xs text-muted">
            Simulated caller / sender address (optional PRO-21)
            <input
              className="min-h-10 rounded-2xl border border-line bg-surface px-3 font-mono text-xs text-paper"
              value={fromAddress}
              onChange={(event) => {
                setFromAddress(event.target.value);
                setPreview(null);
              }}
              placeholder="kvnc...dag or tknc...dag"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-2xl border border-line bg-surface px-3 text-xs text-muted">
            <input
              type="checkbox"
              checked={parallelDryRun}
              onChange={(event) => setParallelDryRun(event.target.checked)}
            />
            Parallel dry-run
          </label>
        </div>

        <div className="grid gap-3">
          {drafts.map((draft, idx) => {
            const validation = validateBatchCallDraft(draft, resolvedChainId);
            const fieldError = (field: string) =>
              !validation.ok
                ? validation.errors.find((entry) => entry.field === field)?.message
                : undefined;
            const showContractError = draft.contract.trim().length > 0 && fieldError("contract");
            const showArgsError = draft.argsInput.trim().length > 0 && fieldError("args");
            const showValueError = (draft.valueAtoms ?? "").trim().length > 0 && fieldError("valueAtoms");
            const showGasError = (draft.gasLimit ?? "").trim().length > 0 && fieldError("gasLimit");

            return (
              <div
                key={draft.id}
                className="rounded-2xl border border-line/80 bg-surface p-3"
                data-testid={`batch-call-item-${idx}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs font-medium text-paper">
                    Call #{idx + 1}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className="min-h-8 rounded-full border border-line px-2.5 text-xs text-muted disabled:opacity-35"
                      disabled={running || idx === 0}
                      onClick={() => moveCall(idx, -1)}
                      aria-label={`Move call ${idx + 1} up`}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="min-h-8 rounded-full border border-line px-2.5 text-xs text-muted disabled:opacity-35"
                      disabled={running || idx === drafts.length - 1}
                      onClick={() => moveCall(idx, 1)}
                      aria-label={`Move call ${idx + 1} down`}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="min-h-8 rounded-full border border-line px-2.5 text-xs text-clay disabled:opacity-35"
                      disabled={running}
                      onClick={() => removeCall(draft.id)}
                      aria-label={`Remove call ${idx + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="mt-2.5 grid gap-2.5">
                  <label className="grid gap-1 text-xs text-muted">
                    Contract address (PRO-21)
                    <input
                      className="min-h-10 rounded-xl border border-line bg-ink px-3 font-mono text-xs text-paper"
                      value={draft.contract}
                      onChange={(event) => updateDraft(draft.id, { contract: event.target.value })}
                      placeholder="kvnc...dag or tknc...dag"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    {showContractError ? (
                      <span className="text-clay">{showContractError}</span>
                    ) : null}
                  </label>

                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <label className="grid gap-1 text-xs text-muted">
                      Method name
                      <input
                        className="min-h-10 rounded-xl border border-line bg-ink px-3 font-mono text-xs text-paper"
                        value={draft.method}
                        onChange={(event) => updateDraft(draft.id, { method: event.target.value })}
                        placeholder="e.g. token_transfer"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                    </label>
                    <label className="grid gap-1 text-xs text-muted">
                      Args format
                      <select
                        className="min-h-10 rounded-xl border border-line bg-ink px-3 text-xs text-paper"
                        value={draft.argsFormat}
                        onChange={(event) =>
                          updateDraft(draft.id, {
                            argsFormat: event.target.value as BatchCallArgsFormat,
                          })
                        }
                      >
                        <option value="hex">Hex (0x…)</option>
                        <option value="json">JSON (UTF-8)</option>
                      </select>
                    </label>
                  </div>

                  <label className="grid gap-1 text-xs text-muted">
                    {draft.argsFormat === "hex"
                      ? "Arguments (hex bytes, optional)"
                      : "Arguments (JSON payload, optional)"}
                    <input
                      className="min-h-10 rounded-xl border border-line bg-ink px-3 font-mono text-xs text-paper"
                      value={draft.argsInput}
                      onChange={(event) => updateDraft(draft.id, { argsInput: event.target.value })}
                      placeholder={
                        draft.argsFormat === "hex" ? "0x or empty" : '{"amount": 1000}'
                      }
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    {showArgsError ? <span className="text-clay">{showArgsError}</span> : null}
                  </label>

                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <label className="grid gap-1 text-xs text-muted">
                      Attached value (atoms, optional)
                      <input
                        className="min-h-10 rounded-xl border border-line bg-ink px-3 tabular-nums text-xs text-paper"
                        value={draft.valueAtoms ?? ""}
                        onChange={(event) =>
                          updateDraft(draft.id, { valueAtoms: event.target.value })
                        }
                        placeholder="0"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                      {showValueError ? <span className="text-clay">{showValueError}</span> : null}
                    </label>
                    <label className="grid gap-1 text-xs text-muted">
                      Gas limit (optional)
                      <input
                        className="min-h-10 rounded-xl border border-line bg-ink px-3 tabular-nums text-xs text-paper"
                        value={draft.gasLimit ?? ""}
                        onChange={(event) =>
                          updateDraft(draft.id, { gasLimit: event.target.value })
                        }
                        placeholder="default (auto +20%)"
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                      {showGasError ? <span className="text-clay">{showGasError}</span> : null}
                    </label>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-9 rounded-full border border-line px-3 text-xs text-paper disabled:opacity-40"
              disabled={running}
              onClick={addCall}
            >
              + Add call
            </button>
            <button
              type="button"
              className="min-h-9 rounded-full border border-line px-3 text-xs text-muted disabled:opacity-40"
              disabled={running}
              onClick={clearAll}
            >
              Reset
            </button>
          </div>
          <button
            type="button"
            className="min-h-10 rounded-full bg-copper px-4 text-xs font-medium text-copper-ink disabled:opacity-40"
            disabled={!net.online || running || drafts.length === 0}
            onClick={() => void runEstimateAndDryRun()}
          >
            {running ? "Running batch preview…" : "Estimate & Dry-Run Batch"}
          </button>
        </div>

        {!net.online ? (
          <p className="text-xs text-muted">
            Connect to a node to run batch estimation and dry-run simulation.
          </p>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-2xl border border-clay bg-clay/10 px-3 py-2 text-xs text-clay"
          >
            {error}
          </div>
        ) : null}

        {preview ? (
          <div className="grid gap-3" data-testid="batch-call-preview-results">
            <div
              role={preview.allSucceeded ? "status" : "alert"}
              className={`rounded-2xl border px-3 py-3 text-xs ${
                preview.allSucceeded
                  ? "border-sage/60 bg-sage/10"
                  : "border-clay bg-clay/10"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className={`font-medium ${preview.allSucceeded ? "text-sage" : "text-clay"}`}
                >
                  {preview.allSucceeded
                    ? `All ${preview.totalCalls} ${preview.totalCalls === 1 ? "call" : "calls"} passed dry-run`
                    : `${preview.passedCount} passed, ${preview.revertedCount} reverted`}
                </span>
                <span className="tabular-nums text-muted">
                  Chain {preview.chainId} · Nonces {nonceRangeLabel}
                </span>
              </div>
              <dl className="mt-2.5 grid gap-1.5">
                <div className="flex items-baseline justify-between gap-3 border-t border-line/60 pt-1.5">
                  <dt className="text-muted">Total wire size</dt>
                  <dd className="tabular-nums text-right text-paper">
                    {preview.totalEstimatedTxSize} bytes
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-line/60 pt-1.5">
                  <dt className="text-muted">Fee rate</dt>
                  <dd className="tabular-nums text-right text-paper">
                    {formatAtoms(preview.feeRatePerByte)} atoms/byte
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-line/60 pt-1.5">
                  <dt className="text-muted">
                    Total fee ({formatSafetyMarginPercent(preview.feeMarginBps)})
                  </dt>
                  <dd className="tabular-nums text-right text-paper">
                    {preview.totalFeeKvnc} KVNC ({formatAtoms(preview.totalFeeAtoms)} atoms)
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-line/60 pt-1.5">
                  <dt className="text-muted">Total attached value</dt>
                  <dd className="tabular-nums text-right text-paper">
                    {preview.totalValueKvnc} KVNC ({formatAtoms(preview.totalValueAtoms)} atoms)
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-line/60 pt-1.5">
                  <dt className="text-muted">Total estimated cost</dt>
                  <dd className="tabular-nums text-right font-medium text-paper">
                    {preview.totalCostKvnc} KVNC ({formatAtoms(preview.totalCostAtoms)} atoms)
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3 border-t border-line/60 pt-1.5">
                  <dt className="text-muted">Total gas limit</dt>
                  <dd className="tabular-nums text-right text-paper">
                    {formatAtoms(preview.totalGasLimit)}
                  </dd>
                </div>
              </dl>
            </div>

            <ul className="grid gap-2">
              {preview.calls.map((item) => {
                const ok = item.dryRun.status === "success";
                return (
                  <li
                    key={item.id}
                    className={`rounded-2xl border px-3 py-2.5 text-xs ${
                      ok ? "border-line bg-surface" : "border-clay/80 bg-clay/10"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-paper">
                        #{item.index + 1} {shortenAddress(item.contract)}.{item.method}
                      </span>
                      <span
                        className={`rounded-full border px-2 py-0.5 font-medium ${
                          ok
                            ? "border-sage/60 bg-sage/10 text-sage"
                            : "border-clay bg-clay/10 text-clay"
                        }`}
                      >
                        {ok ? "Success" : "Reverted"}
                      </span>
                    </div>
                    <p className="mt-1.5 tabular-nums text-muted">
                      nonce={item.nonce?.toString() ?? "auto"} · {item.estimatedTxSize}B · gas=
                      {formatAtoms(item.gasLimit)} · fee={item.marginedFeeKvnc} KVNC (
                      {formatAtoms(item.marginedFeeAtoms)} atoms)
                      {item.valueAtoms > 0n ? ` · value=${item.valueKvnc} KVNC` : ""}
                    </p>
                    {item.dryRun.status === "success" ? (
                      <p className="mt-1 break-all font-mono text-paper/90">
                        {item.dryRun.returnSummary}
                      </p>
                    ) : (
                      <p className="mt-1 break-words text-clay">
                        Revert reason: {item.dryRun.revertReason}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
