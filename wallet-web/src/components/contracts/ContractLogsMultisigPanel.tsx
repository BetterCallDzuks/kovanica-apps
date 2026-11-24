import { useEffect, useState } from "react";
import { inferContractLogKind } from "@/core/call-estimate";
import type { ContractName } from "@/core/contracts";
import {
  DEFAULT_CONTRACT_LOGS_MAX_SPAN,
  MULTISIG_BUNDLE_FORMAT,
  evaluateMultisigQuorum,
  exportMultisigApprovalBundle,
  fetchContractLogsPage,
  formatQuorumProgress,
  inspectMultisigBundle,
  resolveMultisigChainId,
  validatePro21ContractAddress,
  type ContractLogKind,
  type ContractLogSummaryItem,
  type ExportMultisigBundleResult,
  type InspectedMultisigBundleResult,
  type MultisigApprovalEntry,
} from "@/lib/contractLogsAndMultisig";
import { presetById } from "@/lib/networks";
import { createPaginatedLogsClient } from "@/services/rpc";
import { useNetwork } from "@/stores/network";

type PanelTab = "logs" | "multisig";

type ApprovalDraftRow = {
  id: number;
  signer: string;
  signatureHex: string;
};

const LOG_KIND_CHOICES: ReadonlyArray<{ value: ContractLogKind | "none"; label: string }> = [
  { value: "none", label: "Raw (no decode)" },
  { value: "token_metadata", label: "token_metadata" },
  { value: "token_pool", label: "token_pool" },
  { value: "htlc", label: "htlc" },
  { value: "vault", label: "vault" },
  { value: "multisig_state", label: "multisig_state" },
  { value: "multisig_tx", label: "multisig_tx" },
  { value: "name", label: "name" },
  { value: "nft_metadata", label: "nft_metadata" },
  { value: "escrow", label: "escrow" },
];

function parseSignersList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function shortenHex(value: string, lead = 10, tail = 8): string {
  if (value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function ContractLogsMultisigPanel({
  defaultContractAddress = "",
  defaultContractFamily = "token",
}: {
  defaultContractAddress?: string;
  defaultContractFamily?: ContractName;
}) {
  const net = useNetwork();
  const resolvedChainId = resolveMultisigChainId(
    net.probedChainId ?? presetById(net.presetId).expectedChainId,
  );

  const [activeTab, setActiveTab] = useState<PanelTab>("logs");

  // --- Tab 1: Paginated Contract Event Logs ---
  const [logContract, setLogContract] = useState(defaultContractAddress);
  const [fromBlock, setFromBlock] = useState("0");
  const [toBlock, setToBlock] = useState("500");
  const [maxSpan, setMaxSpan] = useState(String(DEFAULT_CONTRACT_LOGS_MAX_SPAN));
  const [pageLimit, setPageLimit] = useState("50");
  const [logKind, setLogKind] = useState<ContractLogKind | "none">(
    () => inferContractLogKind(defaultContractFamily) ?? "none",
  );
  const [logItems, setLogItems] = useState<ContractLogSummaryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pagesFetched, setPagesFetched] = useState(0);
  const [chunksScanned, setChunksScanned] = useState(0);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultContractAddress.trim()) {
      setLogContract((current) => current || defaultContractAddress);
    }
  }, [defaultContractAddress]);

  useEffect(() => {
    setLogKind(inferContractLogKind(defaultContractFamily) ?? "none");
  }, [defaultContractFamily]);

  const contractCheck = logContract.trim()
    ? validatePro21ContractAddress(logContract, resolvedChainId)
    : null;

  async function runLogQuery(resumeCursor?: string) {
    setLogsError(null);
    if (!net.online) {
      setLogsError("The node is offline, so contract event logs cannot be queried.");
      return;
    }

    const parsedSpan = Number.parseInt(maxSpan.trim(), 10);
    const parsedLimit = Number.parseInt(pageLimit.trim(), 10);
    setLoadingLogs(true);
    try {
      const client = createPaginatedLogsClient(net.rpcUrl);
      const page = await fetchContractLogsPage(client, {
        contractAddress: logContract.trim() || undefined,
        chainId: resolvedChainId,
        fromBlock,
        toBlock,
        maxSpan: Number.isFinite(parsedSpan) ? parsedSpan : DEFAULT_CONTRACT_LOGS_MAX_SPAN,
        maxPages: 1,
        pageLimit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
        cursor: resumeCursor,
        logKind: logKind === "none" ? undefined : logKind,
      });

      if (resumeCursor) {
        setLogItems((prev) => {
          const offset = prev.length;
          const appended = page.items.map((item, idx) => ({ ...item, index: offset + idx }));
          return [...prev, ...appended];
        });
        setPagesFetched((prev) => prev + page.pagesFetched);
        setChunksScanned((prev) => prev + page.chunksScanned);
      } else {
        setLogItems(page.items);
        setPagesFetched(page.pagesFetched);
        setChunksScanned(page.chunksScanned);
      }
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      if (!resumeCursor) {
        setLogItems([]);
        setNextCursor(null);
        setHasMore(false);
        setPagesFetched(0);
        setChunksScanned(0);
      }
      setLogsError(err instanceof Error ? err.message : "Could not fetch contract logs.");
    } finally {
      setLoadingLogs(false);
    }
  }

  function clearLogs() {
    setLogItems([]);
    setNextCursor(null);
    setHasMore(false);
    setPagesFetched(0);
    setChunksScanned(0);
    setLogsError(null);
  }

  // --- Tab 2: Air-Gapped Multisig Bundle Export / Verify ---
  const [msAddress, setMsAddress] = useState(defaultContractAddress);
  const [msProposalId, setMsProposalId] = useState("1");
  const [msThreshold, setMsThreshold] = useState("2");
  const [msSignersText, setMsSignersText] = useState("");
  const [msDescription, setMsDescription] = useState("");
  const [msPayloadHex, setMsPayloadHex] = useState("");
  const [approvalRows, setApprovalRows] = useState<ApprovalDraftRow[]>([
    { id: 1, signer: "", signatureHex: "" },
  ]);
  const [nextApprovalId, setNextApprovalId] = useState(2);
  const [exported, setExported] = useState<ExportMultisigBundleResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copiedBundle, setCopiedBundle] = useState(false);

  const [verifyInput, setVerifyInput] = useState("");
  const [inspected, setInspected] = useState<InspectedMultisigBundleResult | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    if (defaultContractAddress.trim()) {
      setMsAddress((current) => current || defaultContractAddress);
    }
  }, [defaultContractAddress]);

  const parsedSigners = parseSignersList(msSignersText);
  const parsedThreshold = Number.parseInt(msThreshold.trim(), 10);
  const nonEmptyApprovals = approvalRows.filter(
    (row) => row.signer.trim().length > 0 || row.signatureHex.trim().length > 0,
  );

  let liveQuorum = null;
  if (
    parsedSigners.length > 0 &&
    Number.isSafeInteger(parsedThreshold) &&
    parsedThreshold >= 1 &&
    parsedThreshold <= parsedSigners.length
  ) {
    try {
      liveQuorum = evaluateMultisigQuorum({
        signers: parsedSigners,
        approvals: nonEmptyApprovals
          .map((row) => row.signer.trim())
          .filter((signer) => signer.length > 0),
        threshold: parsedThreshold,
      });
    } catch {
      liveQuorum = null;
    }
  }

  function addApprovalRow() {
    setApprovalRows((prev) => [...prev, { id: nextApprovalId, signer: "", signatureHex: "" }]);
    setNextApprovalId((id) => id + 1);
    setExported(null);
  }

  function updateApprovalRow(id: number, patch: Partial<ApprovalDraftRow>) {
    setApprovalRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setExported(null);
    setExportError(null);
  }

  function removeApprovalRow(id: number) {
    setApprovalRows((prev) =>
      prev.length <= 1
        ? [{ id: nextApprovalId, signer: "", signatureHex: "" }]
        : prev.filter((row) => row.id !== id),
    );
    setExported(null);
  }

  function handleExportBundle() {
    setExportError(null);
    setCopiedBundle(false);
    try {
      const approvals: MultisigApprovalEntry[] = nonEmptyApprovals.map((row) => ({
        signer: row.signer.trim(),
        signatureHex: row.signatureHex.trim(),
      }));
      const result = exportMultisigApprovalBundle({
        chainId: resolvedChainId,
        multisigAddress: msAddress.trim(),
        proposalId: msProposalId.trim(),
        threshold: parsedThreshold,
        signers: parsedSigners,
        approvals,
        ...(msPayloadHex.trim() ? { payloadHex: msPayloadHex.trim() } : {}),
        ...(msDescription.trim() ? { description: msDescription.trim() } : {}),
      });
      setExported(result);
    } catch (err) {
      setExported(null);
      setExportError(
        err instanceof Error ? err.message : "Could not encode multisig proposal bundle.",
      );
    }
  }

  async function handleCopyBundle() {
    if (!exported) return;
    try {
      await navigator.clipboard.writeText(exported.prettyJson);
      setCopiedBundle(true);
      setTimeout(() => setCopiedBundle(false), 2000);
    } catch {
      setExportError("Could not copy bundle JSON to clipboard.");
    }
  }

  function handleDownloadBundle() {
    if (!exported) return;
    const blob = new Blob([exported.prettyJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `kovanica-multisig-proposal-${exported.bundle.proposalId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleInspectBundle() {
    setVerifyError(null);
    try {
      const result = inspectMultisigBundle(verifyInput);
      setInspected(result);
    } catch (err) {
      setInspected(null);
      setVerifyError(err instanceof Error ? err.message : "Invalid multisig bundle JSON.");
    }
  }

  const activeQuorum = exported?.quorum ?? liveQuorum;

  return (
    <section
      className="rounded-3xl border border-line bg-ink px-4 py-4 text-sm"
      aria-label="Contract Event Logs and Air-Gapped Multisig Bundle Panel"
      data-testid="contract-logs-multisig-panel"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium text-paper">Contract Logs &amp; Multisig Bundles</h3>
          <p className="mt-1 text-xs text-muted">
            Inspect paginated on-chain contract events or export/verify air-gapped{" "}
            <span className="font-mono">{MULTISIG_BUNDLE_FORMAT}</span> approval bundles.
          </p>
        </div>
        <span className="rounded-full border border-sage/50 bg-sage/10 px-2.5 py-0.5 text-xs text-sage">
          Read-only · Zero private keys
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Contract tools">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "logs"}
          className={`min-h-9 rounded-full border px-3.5 text-xs font-medium ${
            activeTab === "logs"
              ? "border-copper bg-copper/10 text-paper"
              : "border-line text-muted"
          }`}
          onClick={() => setActiveTab("logs")}
        >
          Contract Event Logs
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "multisig"}
          className={`min-h-9 rounded-full border px-3.5 text-xs font-medium ${
            activeTab === "multisig"
              ? "border-copper bg-copper/10 text-paper"
              : "border-line text-muted"
          }`}
          onClick={() => setActiveTab("multisig")}
        >
          Multisig Bundle Export/Verify
        </button>
      </div>

      {activeTab === "logs" ? (
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-xs text-muted">
            Contract address (optional PRO-21 filter)
            <input
              className="min-h-10 rounded-2xl border border-line bg-surface px-3 font-mono text-xs text-paper"
              value={logContract}
              onChange={(event) => setLogContract(event.target.value)}
              placeholder="kvnc...dag or tknc...dag"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          {contractCheck ? (
            <p className={contractCheck.ok ? "text-xs text-sage" : "text-xs text-clay"}>
              {contractCheck.ok ? "Valid PRO-21 contract address" : contractCheck.message}
            </p>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-4">
            <label className="grid gap-1 text-xs text-muted">
              From block
              <input
                className="min-h-10 rounded-2xl border border-line bg-surface px-3 tabular-nums text-xs text-paper"
                value={fromBlock}
                onChange={(event) => setFromBlock(event.target.value)}
                placeholder="0"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted">
              To block
              <input
                className="min-h-10 rounded-2xl border border-line bg-surface px-3 tabular-nums text-xs text-paper"
                value={toBlock}
                onChange={(event) => setToBlock(event.target.value)}
                placeholder="500"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted">
              Max span
              <input
                className="min-h-10 rounded-2xl border border-line bg-surface px-3 tabular-nums text-xs text-paper"
                value={maxSpan}
                onChange={(event) => setMaxSpan(event.target.value)}
                placeholder="500"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted">
              Page limit
              <input
                className="min-h-10 rounded-2xl border border-line bg-surface px-3 tabular-nums text-xs text-paper"
                value={pageLimit}
                onChange={(event) => setPageLimit(event.target.value)}
                placeholder="50"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-2">
            <label className="grid gap-1 text-xs text-muted">
              Log decoder
              <select
                className="min-h-9 rounded-full border border-line bg-surface px-3 text-xs text-paper"
                value={logKind}
                onChange={(event) => setLogKind(event.target.value as ContractLogKind | "none")}
              >
                {LOG_KIND_CHOICES.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-9 rounded-full border border-copper bg-copper/15 px-3.5 text-xs font-medium text-paper disabled:opacity-40"
                disabled={!net.online || loadingLogs || (contractCheck != null && !contractCheck.ok)}
                onClick={() => void runLogQuery()}
              >
                {loadingLogs ? "Fetching…" : "Fetch logs"}
              </button>
              {hasMore && nextCursor ? (
                <button
                  type="button"
                  className="min-h-9 rounded-full border border-line px-3 text-xs text-paper disabled:opacity-40"
                  disabled={!net.online || loadingLogs}
                  onClick={() => void runLogQuery(nextCursor)}
                >
                  {loadingLogs ? "Loading…" : "Load more"}
                </button>
              ) : null}
              {logItems.length > 0 || pagesFetched > 0 ? (
                <button
                  type="button"
                  className="min-h-9 rounded-full border border-line px-3 text-xs text-muted"
                  disabled={loadingLogs}
                  onClick={clearLogs}
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          {logsError ? (
            <div
              role="alert"
              className="rounded-2xl border border-clay bg-clay/10 px-3 py-2 text-xs text-clay"
            >
              {logsError}
            </div>
          ) : null}

          {pagesFetched > 0 ? (
            <div className="rounded-2xl border border-line bg-surface px-3 py-2 text-xs text-muted">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {logItems.length} log{logItems.length === 1 ? "" : "s"} · {pagesFetched} page
                  {pagesFetched === 1 ? "" : "s"} · {chunksScanned} chunk
                  {chunksScanned === 1 ? "" : "s"}
                </span>
                <span className="font-mono text-paper/80">
                  {hasMore && nextCursor ? `cursor ${nextCursor}` : "end of range"}
                </span>
              </div>
            </div>
          ) : null}

          {logItems.length > 0 ? (
            <ul className="grid max-h-80 gap-2 overflow-y-auto pr-1">
              {logItems.map((item) => (
                <li
                  key={`${item.index}-${item.blockHeight ?? "?"}-${item.logIndex ?? "?"}`}
                  className="rounded-2xl border border-line bg-surface px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-muted">
                    <span className="font-mono text-paper">
                      #{item.index + 1} · block {item.blockHeight ?? "?"} · log{" "}
                      {item.logIndex ?? "?"}
                    </span>
                    {item.transactionHash ? (
                      <span className="font-mono">{shortenHex(item.transactionHash)}</span>
                    ) : null}
                  </div>
                  {item.topics.length > 0 ? (
                    <p className="mt-1 truncate font-mono text-muted">
                      topics: {item.topics.join(", ")}
                    </p>
                  ) : null}
                  <p className="mt-1 break-all font-mono text-paper/90">{item.decodedSummary}</p>
                </li>
              ))}
            </ul>
          ) : pagesFetched > 0 && !loadingLogs ? (
            <p className="text-xs text-muted">No contract logs matched this block range.</p>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 grid gap-4">
          <div className="grid gap-3 rounded-2xl border border-line bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-medium text-paper">
                Export Air-Gapped Bundle (chainId {resolvedChainId})
              </h4>
              {activeQuorum ? (
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${
                    activeQuorum.quorumReached
                      ? "border-sage/60 bg-sage/10 text-sage"
                      : "border-copper/60 bg-copper/10 text-copper"
                  }`}
                >
                  {formatQuorumProgress(activeQuorum)}
                </span>
              ) : null}
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <label className="grid gap-1 text-xs text-muted sm:col-span-2">
                Multisig contract address (PRO-21)
                <input
                  className="min-h-9 rounded-xl border border-line bg-ink px-3 font-mono text-xs text-paper"
                  value={msAddress}
                  onChange={(event) => {
                    setMsAddress(event.target.value);
                    setExported(null);
                  }}
                  placeholder="kvnc...dag or tknc...dag"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted">
                Proposal ID
                <input
                  className="min-h-9 rounded-xl border border-line bg-ink px-3 font-mono text-xs text-paper"
                  value={msProposalId}
                  onChange={(event) => {
                    setMsProposalId(event.target.value);
                    setExported(null);
                  }}
                  placeholder="1"
                />
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <label className="grid gap-1 text-xs text-muted">
                Threshold (M-of-N)
                <input
                  className="min-h-9 rounded-xl border border-line bg-ink px-3 tabular-nums text-xs text-paper"
                  value={msThreshold}
                  onChange={(event) => {
                    setMsThreshold(event.target.value);
                    setExported(null);
                  }}
                  placeholder="2"
                />
              </label>
              <label className="grid gap-1 text-xs text-muted sm:col-span-2">
                Description (optional if payloadHex provided)
                <input
                  className="min-h-9 rounded-xl border border-line bg-ink px-3 text-xs text-paper"
                  value={msDescription}
                  onChange={(event) => {
                    setMsDescription(event.target.value);
                    setExported(null);
                  }}
                  placeholder="Treasury disbursement #1"
                />
              </label>
            </div>

            <label className="grid gap-1 text-xs text-muted">
              Authorized signers (comma or newline separated PRO-21 addresses)
              <textarea
                className="min-h-16 rounded-xl border border-line bg-ink px-3 py-2 font-mono text-xs text-paper"
                value={msSignersText}
                onChange={(event) => {
                  setMsSignersText(event.target.value);
                  setExported(null);
                }}
                placeholder="tknc...dag, tknc...dag"
                spellCheck={false}
              />
            </label>

            <label className="grid gap-1 text-xs text-muted">
              Payload hex (optional 0x-prefixed hex)
              <input
                className="min-h-9 rounded-xl border border-line bg-ink px-3 font-mono text-xs text-paper"
                value={msPayloadHex}
                onChange={(event) => {
                  setMsPayloadHex(event.target.value);
                  setExported(null);
                }}
                placeholder="0xdeadbeef"
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">Collected approvals (signer + 64-byte sig)</span>
                <button
                  type="button"
                  className="min-h-8 rounded-full border border-line px-2.5 text-xs text-paper"
                  onClick={addApprovalRow}
                >
                  + Add approval
                </button>
              </div>
              {approvalRows.map((row, idx) => (
                <div
                  key={row.id}
                  className="grid gap-2 rounded-xl border border-line/70 bg-ink p-2 sm:grid-cols-[1fr_1fr_auto]"
                >
                  <input
                    className="min-h-8 rounded-lg border border-line bg-surface px-2.5 font-mono text-xs text-paper"
                    value={row.signer}
                    onChange={(event) => updateApprovalRow(row.id, { signer: event.target.value })}
                    placeholder={`Approver #${idx + 1} PRO-21`}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                  <input
                    className="min-h-8 rounded-lg border border-line bg-surface px-2.5 font-mono text-xs text-paper"
                    value={row.signatureHex}
                    onChange={(event) =>
                      updateApprovalRow(row.id, { signatureHex: event.target.value })
                    }
                    placeholder="0x<128 hex chars>"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="min-h-8 rounded-lg border border-line px-2 text-xs text-muted"
                    onClick={() => removeApprovalRow(row.id)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-9 rounded-full border border-copper bg-copper/15 px-3.5 text-xs font-medium text-paper"
                onClick={handleExportBundle}
              >
                Export bundle JSON
              </button>
              {exported ? (
                <>
                  <button
                    type="button"
                    className="min-h-9 rounded-full border border-line px-3 text-xs text-paper"
                    onClick={() => void handleCopyBundle()}
                  >
                    {copiedBundle ? "Copied!" : "Copy JSON"}
                  </button>
                  <button
                    type="button"
                    className="min-h-9 rounded-full border border-line px-3 text-xs text-paper"
                    onClick={handleDownloadBundle}
                  >
                    Download .json
                  </button>
                </>
              ) : null}
            </div>

            {exportError ? (
              <div
                role="alert"
                className="rounded-xl border border-clay bg-clay/10 px-3 py-2 text-xs text-clay"
              >
                {exportError}
              </div>
            ) : null}

            {exported ? (
              <pre className="max-h-48 overflow-auto rounded-xl border border-line bg-ink p-3 font-mono text-xs text-paper/90">
                {exported.prettyJson}
              </pre>
            ) : null}
          </div>

          <div className="grid gap-3 rounded-2xl border border-line bg-surface p-3">
            <h4 className="text-xs font-medium text-paper">Verify / Inspect Bundle JSON</h4>
            <textarea
              className="min-h-24 rounded-xl border border-line bg-ink px-3 py-2 font-mono text-xs text-paper"
              value={verifyInput}
              onChange={(event) => setVerifyInput(event.target.value)}
              placeholder={`Paste ${MULTISIG_BUNDLE_FORMAT} JSON here…`}
              spellCheck={false}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-9 rounded-full border border-line px-3.5 text-xs font-medium text-paper disabled:opacity-40"
                disabled={!verifyInput.trim()}
                onClick={handleInspectBundle}
              >
                Verify bundle
              </button>
              {exported ? (
                <button
                  type="button"
                  className="min-h-9 rounded-full border border-line px-3 text-xs text-muted"
                  onClick={() => {
                    setVerifyInput(exported.prettyJson);
                    setVerifyError(null);
                  }}
                >
                  Load exported bundle
                </button>
              ) : null}
            </div>

            {verifyError ? (
              <div
                role="alert"
                className="rounded-xl border border-clay bg-clay/10 px-3 py-2 text-xs text-clay"
              >
                {verifyError}
              </div>
            ) : null}

            {inspected ? (
              <div
                role="status"
                className={`rounded-xl border px-3 py-2 text-xs ${
                  inspected.quorum.quorumReached
                    ? "border-sage/60 bg-sage/10"
                    : "border-copper/60 bg-copper/10"
                }`}
              >
                <p
                  className={`font-medium ${
                    inspected.quorum.quorumReached ? "text-sage" : "text-copper"
                  }`}
                >
                  {inspected.quorumSummary}
                </p>
                <dl className="mt-2 grid gap-1 text-paper/90">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Format</dt>
                    <dd className="font-mono">
                      {inspected.bundle.format} (v{inspected.bundle.version})
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Chain / Proposal</dt>
                    <dd className="font-mono">
                      chain {inspected.bundle.chainId} · #{inspected.bundle.proposalId}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Multisig</dt>
                    <dd className="font-mono">{shortenHex(inspected.bundle.multisigAddress, 12, 8)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Signers / Valid / Unknown / Dup</dt>
                    <dd className="tabular-nums">
                      {inspected.quorum.uniqueSigners.length} / {inspected.quorum.validApprovals.length}{" "}
                      / {inspected.quorum.unknownApprovals.length} /{" "}
                      {inspected.quorum.duplicateApprovals.length}
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
