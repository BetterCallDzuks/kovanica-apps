import React, { useEffect, useState } from "react";
import type { PendingApprovalRequest } from "../core/provider-protocol";

async function sendBg<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (res: { ok?: boolean; result?: T; error?: string }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!res?.ok) {
        reject(new Error(res?.error ?? "Background request failed"));
        return;
      }
      resolve(res.result as T);
    });
  });
}

export function ApprovalApp(): React.JSX.Element {
  const [req, setReq] = useState<PendingApprovalRequest | null>(null);
  const [error, setError] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const requestId = new URLSearchParams(window.location.search).get("requestId") ?? "";

  useEffect(() => {
    if (!requestId) {
      setError("Missing approval requestId");
      return;
    }
    void sendBg<PendingApprovalRequest | null>("APPROVAL_GET_REQUEST", { requestId })
      .then((found) => {
        if (!found) {
          setError("Approval request expired or already handled");
        } else {
          setReq(found);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [requestId]);

  async function resolve(approved: boolean): Promise<void> {
    setSubmitting(true);
    setError("");
    try {
      await sendBg("APPROVAL_RESOLVE", {
        requestId,
        approved,
        reason: approved ? undefined : "User rejected in approval popup",
      });
      window.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (error) {
    return (
      <div className="app-shell">
        <div className="error-box">{error}</div>
        <button className="secondary" onClick={() => window.close()}>
          Close
        </button>
      </div>
    );
  }

  if (!req) {
    return <div className="app-shell">Loading approval request...</div>;
  }

  const { preview } = req;
  const recipientInvalid = preview.recipientCheck && !preview.recipientCheck.valid;

  return (
    <div className="app-shell">
      <div className="header">
        <div className="brand">{preview.title}</div>
        <span className="badge">Chain #{preview.chainId}</span>
      </div>

      <div className="card">
        <div className="kv-item">
          <span className="kv-label">Origin</span>
          <span className="kv-value mono">{req.origin}</span>
        </div>
        <div className="kv-item">
          <span className="kv-label">Method</span>
          <span className="kv-value mono">{preview.method}</span>
        </div>
        <div className="muted">{preview.summary}</div>
      </div>

      {preview.recipientCheck && (
        <div className="card">
          <div className="row">
            <strong>PRO-21 Recipient Check</strong>
            <span className={`badge ${preview.recipientCheck.valid ? "ok" : "danger"}`}>
              {preview.recipientCheck.valid ? "PRO-21 Verified" : "Invalid / Rejected"}
            </span>
          </div>
          <div className="mono">{preview.recipientCheck.address}</div>
          {preview.recipientCheck.error && (
            <div className="error-box">{preview.recipientCheck.error}</div>
          )}
          {preview.recipientCheck.warning && (
            <span className="badge warn">{preview.recipientCheck.warning}</span>
          )}
        </div>
      )}

      {preview.feeEstimate && (
        <div className="card">
          <strong>Wave B Fee & Storage Deposit Estimate</strong>
          <div className="kv-list">
            <div className="kv-item">
              <span className="kv-label">Base Fee / Byte</span>
              <span className="kv-value mono">{preview.feeEstimate.baseFeePerByte} atoms</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Estimated Fee</span>
              <span className="kv-value mono">{preview.feeEstimate.totalFeeKvnc} KVNC</span>
            </div>
            <div className="kv-item">
              <span className="kv-label">Storage Deposit Delta</span>
              <span className="kv-value mono">
                {preview.feeEstimate.storageDepositDeltaKvnc} KVNC
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <strong>Decoded Details</strong>
        <div className="kv-list">
          {preview.details.map((item, idx) => (
            <div key={idx} className="kv-item">
              <span className="kv-label">{item.label}</span>
              <span className="kv-value mono">{item.value}</span>
            </div>
          ))}
        </div>
        <button className="secondary" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? "Hide Raw Payload" : "Inspect Raw Payload"}
        </button>
        {showRaw && <pre className="mono">{JSON.stringify(req.params ?? {}, null, 2)}</pre>}
      </div>

      <div className="row">
        <button
          className="danger"
          style={{ flex: 1 }}
          disabled={submitting}
          onClick={() => void resolve(false)}
        >
          Reject
        </button>
        <button
          className="primary"
          style={{ flex: 1 }}
          disabled={submitting || Boolean(recipientInvalid)}
          onClick={() => void resolve(true)}
        >
          Approve
        </button>
      </div>
    </div>
  );
}
