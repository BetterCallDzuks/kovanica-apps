import { useEffect, useState } from "react";
import { toast } from "sonner";

type ReceiveMode = "pro21" | "stealth";

export function Receive({
  address,
  pathLabel,
  stealthMetaAddress,
}: {
  address: string;
  pathLabel: string;
  stealthMetaAddress?: string | null;
}) {
  const [mode, setMode] = useState<ReceiveMode>("pro21");
  const [qrSvg, setQrSvg] = useState<string | null>(null);

  const hasStealth = Boolean(stealthMetaAddress);
  const activeMode: ReceiveMode = mode === "stealth" && hasStealth ? "stealth" : "pro21";
  const activeValue = activeMode === "stealth" && stealthMetaAddress ? stealthMetaAddress : address;

  useEffect(() => {
    let cancel = false;
    setQrSvg(null);
    void import("qrcode").then((mod) =>
      mod
        .toString(activeValue, {
          type: "svg",
          margin: 2,
          color: { dark: "#09090b", light: "#f2f1ee" },
        })
        .then((svg) => {
          if (!cancel) setQrSvg(svg);
        }),
    );
    return () => {
      cancel = true;
    };
  }, [activeValue]);

  return (
    <div className="grid justify-items-center gap-4">
      {hasStealth ? (
        <div
          className="inline-flex rounded-full border border-line bg-surface p-1 text-xs font-medium"
          role="tablist"
          aria-label="Receive address type"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeMode === "pro21"}
            className={`rounded-full px-4 py-1.5 transition-colors ${
              activeMode === "pro21"
                ? "bg-copper text-copper-ink"
                : "text-muted hover:text-paper"
            }`}
            onClick={() => setMode("pro21")}
          >
            PRO-21 Address
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeMode === "stealth"}
            className={`rounded-full px-4 py-1.5 transition-colors ${
              activeMode === "stealth"
                ? "bg-copper text-copper-ink"
                : "text-muted hover:text-paper"
            }`}
            onClick={() => setMode("stealth")}
          >
            Stealth (KVP-103)
          </button>
        </div>
      ) : null}

      <p className="text-sm text-muted">
        {activeMode === "stealth"
          ? "KVP-103 Dual-Key Stealth Meta-Address (unlinkable one-time payments)"
          : pathLabel}
      </p>

      {qrSvg ? (
        <div
          role="img"
          aria-label={activeMode === "stealth" ? "Stealth Meta-Address QR" : "PRO-21 Address QR"}
          className="h-56 w-56 overflow-hidden rounded-2xl bg-paper p-2 [&>svg]:h-full [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: qrSvg }}
        />
      ) : (
        <div className="h-56 w-56 rounded-2xl border border-line bg-surface" />
      )}

      <p className="mono max-w-full text-center text-sm break-all text-paper">{activeValue}</p>

      <button
        type="button"
        className="min-h-11 rounded-full border border-line px-5 text-paper transition-colors hover:border-copper"
        onClick={() => {
          void navigator.clipboard.writeText(activeValue);
          toast(activeMode === "stealth" ? "Stealth meta-address copied" : "Address copied");
        }}
      >
        {activeMode === "stealth" ? "Copy stealth meta-address" : "Copy address"}
      </button>
    </div>
  );
}
