// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CHAIN_IDS, TESTNET_ADDRESS_PREFIX, encodeAddress } from "kovanica-sdk";

import { ApprovalApp } from "../src/approval/ApprovalApp";
import { ECOSYSTEM_LINKS, resolveEcosystemHref } from "../src/core/ecosystem";
import { DEFAULT_NETWORKS, getNetworkByChainId } from "../src/core/networks";
import { PopupApp } from "../src/popup/PopupApp";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, "..");

const TESTNET_ADDRESS = encodeAddress(new Uint8Array(32).fill(0x21), TESTNET_ADDRESS_PREFIX);

function installChromeMock(chainId: number = CHAIN_IDS.TESTNET) {
  const network = getNetworkByChainId(chainId);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (
        msg: { type: string; payload?: Record<string, unknown> },
        callback: (res: { ok: boolean; result?: unknown }) => void,
      ) => {
        if (msg.type === "WALLET_GET_STATE") {
          callback({
            ok: true,
            result: {
              hasVault: true,
              unlocked: true,
              chainId,
              network,
              networks: DEFAULT_NETWORKS,
              accounts: [
                {
                  index: 0,
                  label: "Account 1",
                  path: "m/44'/3007'/0'/0'/0'",
                  address: TESTNET_ADDRESS,
                  publicKeyHex: "21".repeat(32),
                },
              ],
              activeAccountIndex: 0,
              autoLockMinutes: 15,
              hasPasskey: false,
              connectedOrigins: [],
              sessionKeys: [],
              latestHeadHeight: 123,
            },
          });
          return;
        }
        if (msg.type === "WALLET_FETCH_BALANCE") {
          callback({
            ok: true,
            result: {
              balanceKvnc: "5.0",
              feeEstimate: {
                baseFeePerByte: "1",
                totalFeeKvnc: "0.0001",
              },
            },
          });
          return;
        }
        if (msg.type === "APPROVAL_GET_REQUEST") {
          callback({
            ok: true,
            result: {
              id: "req-test-1",
              origin: "https://dex.kovanica.online",
              method: "signTransaction",
              params: { to: TESTNET_ADDRESS, amount: "1000" },
              createdAt: 1_700_000_000_000,
              preview: {
                method: "signTransaction",
                title: "Approve Transfer",
                summary: "Transfer 0.000001 KVNC",
                chainId,
                recipientCheck: {
                  valid: true,
                  address: TESTNET_ADDRESS,
                  chainId,
                  strictPro21: true,
                  format: "pro21-testnet",
                },
                feeEstimate: {
                  baseFeePerByte: "1",
                  txBytes: 170,
                  gasUsed: "0",
                  gasPriceAtoms: "1",
                  fixedMinFeeAtoms: "100000",
                  totalFeeAtoms: "100000",
                  totalFeeKvnc: "0.0001",
                  storageDepositDeltaAtoms: "0",
                  storageDepositDeltaKvnc: "0",
                  storageDepositPerByte: "0",
                },
                details: [{ label: "To", value: TESTNET_ADDRESS }],
              },
            },
          });
          return;
        }
        callback({ ok: true, result: {} });
      },
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("browser-extension networks, manifest & ecosystem links", () => {
  it("aligns DEFAULT_NETWORKS endpoints and contains zero stale testnet hosts", () => {
    const mainnet = getNetworkByChainId(CHAIN_IDS.MAINNET);
    expect(mainnet.rpcUrl).toBe("https://rpc.kovanica.online/rpc");
    expect(mainnet.wsUrl).toBe("wss://rpc.kovanica.online/ws");
    expect(mainnet.explorerUrl).toBe("https://explorer.kovanica.online");

    const testnet = getNetworkByChainId(CHAIN_IDS.TESTNET);
    expect(testnet.rpcUrl).toBe("https://rpc-testnet.kovanica.online/rpc");
    expect(testnet.wsUrl).toBe("wss://rpc-testnet.kovanica.online/ws");
    expect(testnet.explorerUrl).toBe("https://testnet.kovanica.online/explorer");

    const devnet = getNetworkByChainId(CHAIN_IDS.DEVNET);
    expect(devnet.rpcUrl).toBe("http://127.0.0.1:8545/rpc");
    expect(devnet.wsUrl).toBe("ws://127.0.0.1:8545/ws");

    const serialized = JSON.stringify(DEFAULT_NETWORKS);
    expect(serialized).not.toContain("kovanica.org");
    expect(serialized).not.toContain("KovanicaDAG");
    const allowedRpcHosts = new Set(["rpc.kovanica.online", "rpc-testnet.kovanica.online", "127.0.0.1"]);
    for (const net of DEFAULT_NETWORKS) {
      expect(allowedRpcHosts.has(new URL(net.rpcUrl).hostname)).toBe(true);
    }
  });

  it("matches public/manifest.json host_permissions to DEFAULT_NETWORKS RPC origins", () => {
    const manifestRaw = readFileSync(resolve(EXT_ROOT, "public/manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as { host_permissions: string[] };

    expect(manifest.host_permissions).toContain("https://rpc.kovanica.online/*");
    expect(manifest.host_permissions).toContain("https://rpc-testnet.kovanica.online/*");
    expect(manifest.host_permissions).toContain("http://127.0.0.1:8545/*");
    expect(manifest.host_permissions).toHaveLength(3);

    for (const net of DEFAULT_NETWORKS) {
      const origin = new URL(net.rpcUrl).origin;
      const expectedPattern = `${origin}/*`;
      expect(manifest.host_permissions).toContain(expectedPattern);
    }
  });

  it("maintains valid dual-browser MV3 manifests and required PNG icons for Chrome and Firefox", () => {
    const chromeManifest = JSON.parse(
      readFileSync(resolve(EXT_ROOT, "public/manifest.json"), "utf8"),
    ) as {
      manifest_version: number;
      description: string;
      homepage_url?: string;
      minimum_chrome_version?: string;
      background?: { service_worker?: string; type?: string };
      icons: Record<string, string>;
      host_permissions: string[];
    };

    const firefoxManifest = JSON.parse(
      readFileSync(resolve(EXT_ROOT, "public/manifest.firefox.json"), "utf8"),
    ) as {
      manifest_version: number;
      description: string;
      homepage_url?: string;
      background?: { scripts?: string[]; type?: string };
      icons: Record<string, string>;
      host_permissions: string[];
      browser_specific_settings?: {
        gecko?: {
          id?: string;
          strict_min_version?: string;
          data_collection_permissions?: { required?: string[] };
        };
      };
    };

    expect(chromeManifest.manifest_version).toBe(3);
    expect(firefoxManifest.manifest_version).toBe(3);
    expect(chromeManifest.description.length).toBeLessThanOrEqual(132);
    expect(firefoxManifest.description.length).toBeLessThanOrEqual(132);
    expect(chromeManifest.homepage_url).toBe("https://kovanica.online");
    expect(firefoxManifest.homepage_url).toBe("https://kovanica.online");
    expect(chromeManifest.minimum_chrome_version).toBe("120");
    expect(chromeManifest.background?.service_worker).toBe("background.js");
    expect(firefoxManifest.background?.scripts).toEqual(["background.js"]);
    expect(firefoxManifest.browser_specific_settings?.gecko?.id).toBe("wallet@kovanica.online");
    expect(firefoxManifest.browser_specific_settings?.gecko?.strict_min_version).toBe("128.0");
    expect(firefoxManifest.browser_specific_settings?.gecko?.data_collection_permissions?.required).toEqual([
      "none",
    ]);
    expect(firefoxManifest.host_permissions).toEqual(chromeManifest.host_permissions);

    for (const size of ["16", "32", "48", "128"]) {
      expect(chromeManifest.icons[size]).toBe(`icons/icon-${size}.png`);
      expect(firefoxManifest.icons[size]).toBe(`icons/icon-${size}.png`);
      expect(existsSync(resolve(EXT_ROOT, "public", chromeManifest.icons[size]!))).toBe(true);
    }
  });

  it("exports canonical ECOSYSTEM_LINKS and resolves dynamic Explorer URL", () => {
    expect(ECOSYSTEM_LINKS.map((item) => [item.label, item.href])).toEqual([
      ["kovanica.online", "https://kovanica.online"],
      ["Explorer", "https://testnet.kovanica.online/explorer"],
      ["Swap", "https://testnet.kovanica.online/swap"],
      ["Pools", "https://testnet.kovanica.online/pools"],
      ["RWA", "https://testnet.kovanica.online/rwa"],
      ["Playground", "https://playground.kovanica.online"],
      ["Docs", "https://docs.kovanica.online"],
      ["Wallet Web", "https://testnet.kovanica.online/wallet"],
    ]);

    const allowedHosts = new Set([
      "kovanica.online",
      "testnet.kovanica.online",
      "playground.kovanica.online",
      "docs.kovanica.online",
    ]);
    for (const item of ECOSYSTEM_LINKS) {
      const url = new URL(item.href);
      expect(url.protocol).toBe("https:");
      expect(allowedHosts.has(url.hostname)).toBe(true);
    }

    const explorerItem = ECOSYSTEM_LINKS.find((item) => item.id === "explorer")!;
    expect(resolveEcosystemHref(explorerItem, "https://explorer.kovanica.online")).toBe(
      "https://explorer.kovanica.online",
    );
    expect(resolveEcosystemHref(explorerItem, undefined)).toBe(
      "https://testnet.kovanica.online/explorer",
    );
  });

  it("renders all 4 PopupApp tabs and all 8 ecosystem links with target=_blank and rel=noreferrer", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installChromeMock(CHAIN_IDS.TESTNET);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(PopupApp));
      await Promise.resolve();
      await Promise.resolve();
    });

    const tabButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(".tabs .tab-btn"));
    expect(tabButtons.map((btn) => btn.textContent?.trim())).toEqual([
      "Wallet",
      "Send",
      "Sessions",
      "Security",
    ]);

    // Verify tabs remain interactive
    await act(async () => {
      tabButtons[1]!.click();
    });
    expect(container.textContent).toContain("Send KVNC");

    await act(async () => {
      tabButtons[2]!.click();
    });
    expect(container.textContent).toContain("Wave C Session Keys");

    await act(async () => {
      tabButtons[3]!.click();
    });
    expect(container.textContent).toContain("Security, Passkey & dApps");

    const footerLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".ecosystem-footer a.ecosystem-link"),
    );
    expect(footerLinks).toHaveLength(8);
    expect(
      footerLinks.map((a) => [a.textContent?.trim(), a.getAttribute("href"), a.target, a.rel]),
    ).toEqual(
      ECOSYSTEM_LINKS.map((item) => [item.label, item.href, "_blank", "noreferrer"]),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("resolves PopupApp Explorer footer link to mainnet explorer when Chain 1 is active", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installChromeMock(CHAIN_IDS.MAINNET);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(PopupApp));
      await Promise.resolve();
      await Promise.resolve();
    });

    const footerLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>(".ecosystem-footer a.ecosystem-link"),
    );
    expect(footerLinks).toHaveLength(8);
    const explorerLink = footerLinks.find((a) => a.textContent?.trim() === "Explorer");
    expect(explorerLink).toBeDefined();
    expect(explorerLink!.getAttribute("href")).toBe("https://explorer.kovanica.online");
    expect(explorerLink!.target).toBe("_blank");
    expect(explorerLink!.rel).toBe("noreferrer");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders ApprovalApp without .ecosystem-footer so approval security UX remains isolated", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, "", "?requestId=req-test-1");
    installChromeMock(CHAIN_IDS.TESTNET);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(ApprovalApp));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Approve Transfer");
    expect(container.textContent).toContain("https://dex.kovanica.online");
    expect(container.querySelectorAll(".ecosystem-footer")).toHaveLength(0);
    expect(container.querySelectorAll("a.ecosystem-link")).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it("preserves browser-extension CSS design tokens", () => {
    const styles = readFileSync(resolve(EXT_ROOT, "src/styles.css"), "utf8");
    for (const token of ["#0b0e14", "#131924", "#1b2333", "#273248", "#eef2ff", "#3b82f6", "Inter"]) {
      expect(styles).toContain(token);
    }
  });
});
