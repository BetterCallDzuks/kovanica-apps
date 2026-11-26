import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CHAIN_IDS, TESTNET_ADDRESS_PREFIX, encodeAddress } from "kovanica-sdk";

import { ActivityList } from "@/components/activity/ActivityList";
import { Contracts } from "@/components/contracts/Contracts";
import { SettingsDrawer } from "@/components/settings/SettingsDrawer";
import { ECOSYSTEM_LINKS } from "@/lib/ecosystem";
import {
  EXPLORER_BASE_URLS,
  FALLBACK_RPC,
  LOCAL_NODE_RPC,
  PRESETS,
  explorerBaseUrl,
  explorerTxUrl,
  presetById,
} from "@/lib/networks";
import { WALLET_RPC_METHODS } from "@/lib/rpcMethods";

const HERE = dirname(fileURLToPath(import.meta.url));
const WALLET_WEB_ROOT = resolve(HERE, "../..");

const TESTNET_ADDRESS = encodeAddress(new Uint8Array(32).fill(0x11), TESTNET_ADDRESS_PREFIX);

describe("wallet-web endpoints, explorer helpers, ecosystem links & RPC allowlist", () => {
  it("aligns testnet preset to public testnet RPC while preserving local, hybrid, devnet, and mainnet presets", () => {
    assert.equal(FALLBACK_RPC, "https://rpc-testnet.kovanica.online/rpc");
    assert.equal(LOCAL_NODE_RPC, "http://127.0.0.1:8545");

    const mainnet = presetById("mainnet");
    assert.equal(mainnet.rpcUrl, "https://rpc.kovanica.online/rpc");
    assert.equal(mainnet.expectedChainId, CHAIN_IDS.MAINNET);
    assert.equal(mainnet.localOnly, false);
    assert.equal(mainnet.frozen, true);

    const testnet = presetById("testnet");
    assert.equal(testnet.rpcUrl, FALLBACK_RPC);
    assert.equal(testnet.expectedChainId, CHAIN_IDS.TESTNET);
    assert.equal(testnet.localOnly, false);
    assert.equal(testnet.recommended, true);

    const hybrid = presetById("hybrid");
    assert.equal(hybrid.rpcUrl, LOCAL_NODE_RPC);
    assert.equal(hybrid.expectedChainId, CHAIN_IDS.TESTNET);
    assert.equal(hybrid.localOnly, true);

    const devnet = presetById("devnet");
    assert.equal(devnet.rpcUrl, LOCAL_NODE_RPC);
    assert.equal(devnet.expectedChainId, CHAIN_IDS.DEVNET);
    assert.equal(devnet.localOnly, true);

    assert.equal(PRESETS.length, 4);
  });

  it("resolves chain-aware explorer base and transaction URLs across Chain 1, 2, 3, and null", () => {
    assert.equal(EXPLORER_BASE_URLS.mainnet, "https://explorer.kovanica.online");
    assert.equal(EXPLORER_BASE_URLS.testnet, "https://testnet.kovanica.online/explorer");

    assert.equal(explorerBaseUrl(CHAIN_IDS.MAINNET), "https://explorer.kovanica.online");
    assert.equal(explorerBaseUrl(CHAIN_IDS.TESTNET), "https://testnet.kovanica.online/explorer");
    assert.equal(explorerBaseUrl(CHAIN_IDS.DEVNET), "https://testnet.kovanica.online/explorer");
    assert.equal(explorerBaseUrl(null), "https://testnet.kovanica.online/explorer");
    assert.equal(explorerBaseUrl(undefined), "https://testnet.kovanica.online/explorer");

    assert.equal(
      explorerTxUrl(1, "  0xabc123  "),
      "https://explorer.kovanica.online/tx/0xabc123",
    );
    assert.equal(
      explorerTxUrl(2, "0xdef456"),
      "https://testnet.kovanica.online/explorer/tx/0xdef456",
    );
    assert.equal(
      explorerTxUrl(3, "hash with space"),
      "https://testnet.kovanica.online/explorer/tx/hash%20with%20space",
    );
    assert.equal(explorerTxUrl(null, "0x999"), "https://testnet.kovanica.online/explorer/tx/0x999");
    assert.equal(explorerTxUrl(2, "   "), "https://testnet.kovanica.online/explorer");
  });

  it("exports all 8 canonical HTTPS ecosystem links without stale domains", () => {
    const expected = [
      ["Kovanica", "https://kovanica.online"],
      ["Testnet", "https://testnet.kovanica.online"],
      ["Explorer", "https://testnet.kovanica.online/explorer"],
      ["Swap", "https://testnet.kovanica.online/swap"],
      ["Pools", "https://testnet.kovanica.online/pools"],
      ["RWA", "https://testnet.kovanica.online/rwa"],
      ["Playground", "https://playground.kovanica.online"],
      ["Docs", "https://docs.kovanica.online"],
    ];

    assert.equal(ECOSYSTEM_LINKS.length, 8);
    assert.deepEqual(
      ECOSYSTEM_LINKS.map((item) => [item.label, item.href]),
      expected,
    );

    const allowedHosts = new Set([
      "kovanica.online",
      "testnet.kovanica.online",
      "playground.kovanica.online",
      "docs.kovanica.online",
    ]);

    for (const item of ECOSYSTEM_LINKS) {
      const parsed = new URL(item.href);
      assert.equal(parsed.protocol, "https:");
      assert.equal(allowedHosts.has(parsed.hostname), true, `Unexpected host ${parsed.hostname}`);
    }
  });

  it("exposes all 21 wallet RPC methods including tx history, contract logs, and mempool stats", () => {
    const expectedMethods = [
      "kovanica_syncStatus",
      "kovanica_getBalance",
      "kovanica_getNonce",
      "kovanica_estimateFee",
      "kovanica_estimateGas",
      "kovanica_sendRawTransaction",
      "kovanica_getTransactionReceipt",
      "kovanica_getTransaction",
      "kovanica_getTransactionHistory",
      "kovanica_getLogs",
      "kovanica_mempoolStats",
      "kovanica_blockNumber",
      "kovanica_getStorage",
      "kovanica_getStorageAt",
      "kovanica_call",
      "kovanica_getDagInfo",
      "kovanica_getBlockTemplate",
      "kovanica_getBlockByRound",
      "kovanica_getLeaderHeader",
      "kovanica_requestAirdrop",
      "kovanica_nodeStatus",
    ];

    assert.equal(WALLET_RPC_METHODS.size, 21);
    for (const method of expectedMethods) {
      assert.equal(WALLET_RPC_METHODS.has(method), true, `Missing RPC method ${method}`);
    }

    const rpcFunctionsSource = readFileSync(
      resolve(WALLET_WEB_ROOT, "src/services/rpc.functions.ts"),
      "utf8",
    );
    assert.match(rpcFunctionsSource, /WALLET_RPC_METHODS/);
  });

  it("renders SettingsDrawer Advanced Indexer URL and verifies WalletApp home simplification invariants", () => {
    const settingsHtml = renderToStaticMarkup(
      createElement(SettingsDrawer, { onClose: () => undefined }),
    );
    assert.match(settingsHtml, /<details[^>]*>/);
    assert.match(settingsHtml, />Advanced</);
    assert.match(settingsHtml, /Custom Indexer URL \(optional\)/);

    const walletAppSource = readFileSync(
      resolve(WALLET_WEB_ROOT, "src/components/shell/WalletApp.tsx"),
      "utf8",
    );
    assert.match(walletAppSource, /ECOSYSTEM_LINKS/);
    assert.match(walletAppSource, /aria-label="Kovanica ecosystem"/);
    assert.match(walletAppSource, /data-testid="account-address"/);
    assert.match(walletAppSource, /<FaucetButton address=\{displayAddress\} \/>/);
    assert.match(walletAppSource, /setTab\("contracts"\)/);
    assert.match(walletAppSource, /explorerBaseUrl\(currentChainId\)/);
    assert.equal(walletAppSource.includes("Indexer URL"), false);
  });

  it("renders all 3 mounted contracts sub-tabs and all 7 contract families", () => {
    const html = renderToStaticMarkup(
      createElement(Contracts, {
        onReview: () => undefined,
        ownerAddress: TESTNET_ADDRESS,
      }),
    );

    assert.match(html, /role="tablist"/);
    assert.match(html, /id="contracts-tab-execute"/);
    assert.match(html, /id="contracts-tab-batch"/);
    assert.match(html, /id="contracts-tab-logs-multisig"/);
    assert.match(html, /id="contracts-panel-execute"/);
    assert.match(html, /id="contracts-panel-batch"/);
    assert.match(html, /id="contracts-panel-logs-multisig"/);

    for (const family of ["token", "htlc", "vault", "multisig", "name", "nft", "escrow"]) {
      assert.equal(html.includes(`>${family}<`), true, `Missing contract family ${family}`);
    }

    const contractsSource = readFileSync(
      resolve(WALLET_WEB_ROOT, "src/components/contracts/Contracts.tsx"),
      "utf8",
    );
    const executeStart = contractsSource.indexOf('id="contracts-panel-execute"');
    const batchStart = contractsSource.indexOf('id="contracts-panel-batch"');
    const logsStart = contractsSource.indexOf('id="contracts-panel-logs-multisig"');
    assert.ok(executeStart > 0 && batchStart > executeStart && logsStart > batchStart);

    const executePanelSlice = contractsSource.slice(executeStart, batchStart);
    const batchPanelSlice = contractsSource.slice(batchStart, logsStart);
    assert.match(executePanelSlice, /error\s*&&\s*subTab\s*===\s*"execute"[\s\S]*role="alert"/);
    assert.match(batchPanelSlice, /error\s*&&\s*subTab\s*===\s*"batch"[\s\S]*role="alert"/);
  });

  it("uses chain-aware Explorer links in ActivityList and preserves wallet-web CSS design tokens", () => {
    const activityHtml = renderToStaticMarkup(
      createElement(() => ActivityList({ address: TESTNET_ADDRESS, chainId: CHAIN_IDS.TESTNET })),
    );
    assert.match(activityHtml, /On-chain history/);
    assert.match(activityHtml, /Local device activity/);

    const activitySource = readFileSync(
      resolve(WALLET_WEB_ROOT, "src/components/activity/ActivityList.tsx"),
      "utf8",
    );
    assert.match(activitySource, /explorerTxUrl\(activeChainId, entry\.hash\)/);
    assert.match(activitySource, /explorerTxUrl\(row\.chainId \|\| activeChainId, row\.hash\)/);
    assert.equal(activitySource.includes("https://explorer.kovanica.online/tx/"), false);

    const styles = readFileSync(resolve(WALLET_WEB_ROOT, "src/styles.css"), "utf8");
    for (const token of ["#09090b", "#121214", "#2a2a30", "#F2A900", "IBM Plex Sans", "IBM Plex Mono"]) {
      assert.equal(styles.includes(token), true, `Missing design token ${token}`);
    }
  });
});
