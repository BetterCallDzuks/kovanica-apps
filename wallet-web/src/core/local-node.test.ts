import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLocalRpc, LOCAL_NODE_RPC, PRESETS } from "@/lib/networks";
import { getNodeStatusBadge, useNetwork } from "@/stores/network";

describe("local mobile node wiring & fallback transitions (PRO-50, PRO-54, PRO-51, PRO-48)", () => {
  it("routes to http://127.0.0.1:8545 when local node mode is selected or active", () => {
    assert.equal(LOCAL_NODE_RPC, "http://127.0.0.1:8545");
    assert.equal(isLocalRpc("http://127.0.0.1:8545"), true);
    assert.equal(isLocalRpc("http://localhost:8545"), true);
    assert.equal(isLocalRpc("https://rpc.kovanica.online/rpc"), false);

    // Switch to mainnet remote RPC first
    useNetwork.getState().selectPreset("mainnet");
    assert.equal(useNetwork.getState().rpcUrl, "https://rpc.kovanica.online/rpc");
    assert.equal(useNetwork.getState().localNodeMode, false);

    // Activate local node mode
    useNetwork.getState().setLocalNodeMode(true);
    assert.equal(useNetwork.getState().rpcUrl, "http://127.0.0.1:8545");
    assert.equal(useNetwork.getState().localNodeMode, true);
    assert.equal(useNetwork.getState().nodeMode, "full");
  });

  it("handles fallback state transitions (Full Node <-> Light Mode) without app restart", () => {
    useNetwork.getState().setLocalNodeMode(true);
    assert.equal(useNetwork.getState().nodeMode, "full");

    // Dynamic fallback transition to Light Mode (e.g. low RAM < 256MB, thermal, or battery)
    useNetwork.getState().setNodeMode("light");
    assert.equal(useNetwork.getState().nodeMode, "light");
    assert.equal(useNetwork.getState().localNodeMode, true);
    assert.equal(useNetwork.getState().rpcUrl, "http://127.0.0.1:8545");

    // Dynamic recovery back to Full Node once conditions normalize
    useNetwork.getState().setNodeMode("full");
    assert.equal(useNetwork.getState().nodeMode, "full");
    assert.equal(useNetwork.getState().localNodeMode, true);
    assert.equal(useNetwork.getState().rpcUrl, "http://127.0.0.1:8545");
  });

  it("applies probe updates with node mode dynamically", () => {
    useNetwork.getState().setLocalNodeMode(true);

    // Probe returns light mode due to device resource constraint
    useNetwork.getState().applyProbe({
      chainId: 2,
      height: 1250,
      latencyMs: 15,
      peerCount: 4,
      online: true,
      error: null,
      nodeMode: "light",
    });

    assert.equal(useNetwork.getState().nodeMode, "light");
    assert.equal(useNetwork.getState().committedHeight, 1250);
    assert.equal(useNetwork.getState().peerCount, 4);
    assert.equal(useNetwork.getState().online, true);

    // Later probe returns normalized full node mode
    useNetwork.getState().applyProbe({
      chainId: 2,
      height: 1280,
      latencyMs: 12,
      peerCount: 8,
      online: true,
      error: null,
      nodeMode: "full",
    });

    assert.equal(useNetwork.getState().nodeMode, "full");
    assert.equal(useNetwork.getState().committedHeight, 1280);
    assert.equal(useNetwork.getState().peerCount, 8);
  });

  it("hybrid preset routes to loopback 127.0.0.1:8545", () => {
    const hybrid = PRESETS.find((p) => p.id === "hybrid");
    assert.ok(hybrid);
    assert.equal(hybrid.rpcUrl, "http://127.0.0.1:8545");
    assert.equal(hybrid.localOnly, true);

    useNetwork.getState().selectPreset("hybrid");
    assert.equal(useNetwork.getState().rpcUrl, "http://127.0.0.1:8545");
    assert.equal(useNetwork.getState().localNodeMode, true);
  });

  it("computes live node status badges and sync metrics (PRO-51, PRO-48)", () => {
    // 1. Fallback (Light/Remote) badge when nodeMode is light
    const fallbackBadge = getNodeStatusBadge({
      localNodeMode: true,
      nodeMode: "light",
      committedHeight: 100,
      targetHeight: 100,
      syncing: false,
    });
    assert.equal(fallbackBadge, "Fallback (Light/Remote)");

    // 2. Syncing DAG badge when target > committed or syncing is true
    const syncingBadge = getNodeStatusBadge({
      localNodeMode: true,
      nodeMode: "full",
      committedHeight: 5000,
      targetHeight: 7500,
      syncing: true,
    });
    assert.equal(syncingBadge, "Syncing DAG");

    const targetAheadBadge = getNodeStatusBadge({
      localNodeMode: true,
      nodeMode: "full",
      committedHeight: 5000,
      targetHeight: 7500,
      syncing: false,
    });
    assert.equal(targetAheadBadge, "Syncing DAG");

    // 3. Full Node Active badge when caught up and idle in full mode
    const activeBadge = getNodeStatusBadge({
      localNodeMode: true,
      nodeMode: "full",
      committedHeight: 8000,
      targetHeight: 8000,
      syncing: false,
    });
    assert.equal(activeBadge, "Full Node Active");

    // 4. Stores live DAG sync metrics on probe update
    useNetwork.getState().setLocalNodeMode(true);
    useNetwork.getState().applyProbe({
      chainId: 2,
      height: 9100,
      targetHeight: 10500,
      syncing: true,
      peerCount: 12,
      latencyMs: 5,
      online: true,
      error: null,
      nodeMode: "full",
    });

    const state = useNetwork.getState();
    assert.equal(state.committedHeight, 9100);
    assert.equal(state.targetHeight, 10500);
    assert.equal(state.syncing, true);
    assert.equal(state.peerCount, 12);
    assert.equal(getNodeStatusBadge(state), "Syncing DAG");

    // When caught up:
    useNetwork.getState().applyProbe({
      chainId: 2,
      height: 10500,
      targetHeight: 10500,
      syncing: false,
      peerCount: 12,
      latencyMs: 4,
      online: true,
      error: null,
      nodeMode: "full",
    });

    const syncedState = useNetwork.getState();
    assert.equal(syncedState.committedHeight, 10500);
    assert.equal(syncedState.targetHeight, 10500);
    assert.equal(syncedState.syncing, false);
    assert.equal(getNodeStatusBadge(syncedState), "Full Node Active");
  });
});
