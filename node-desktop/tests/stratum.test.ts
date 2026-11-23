import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildSanitizedStratumDiagnostics,
  evaluateStratumAlerts,
  formatRpcProbeResult,
  mountStratumApp,
  probeStratumUpstreamRpc,
  stratumStatusLabel,
  toStratumPayload,
  validateStratumForm,
  type StratumFormInput,
  type StratumSnapshot,
} from "../src/stratum.ts";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, "../index.html"), "utf8");
const css = readFileSync(join(root, "../src/styles.css"), "utf8");

interface Pending {
  command: string;
  args?: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface FakeEl {
  id: string;
  tag: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  dataset: Record<string, string | undefined>;
  children: FakeEl[];
  focused: boolean;
  scrollTop: number;
  scrollHeight: number;
  listeners: Record<string, Array<() => void>>;
  addEventListener(type: string, listener: () => void): void;
  dispatch(type: string): void;
  focus(): void;
  replaceChildren(): void;
  append(...nodes: FakeEl[]): void;
}

function element(tag: string, id = ""): FakeEl {
  const el: FakeEl = {
    id,
    tag,
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    dataset: {},
    children: [],
    focused: false,
    scrollTop: 0,
    scrollHeight: 0,
    listeners: {},
    addEventListener(type, listener) {
      (el.listeners[type] ??= []).push(listener);
    },
    dispatch(type) {
      for (const listener of el.listeners[type] ?? []) listener();
    },
    focus() {
      el.focused = true;
    },
    replaceChildren() {
      el.children = [];
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
  };
  return el;
}

function readout(el: FakeEl): Record<string, string> {
  const rows: Record<string, string> = {};
  for (let i = 0; i < el.children.length; i += 2) {
    rows[el.children[i].textContent] = el.children[i + 1].textContent;
  }
  return rows;
}

function field(kind: "value" | "unknown" | "unavailable", value?: string) {
  return { kind, value: value ?? null };
}

function sampleSnapshot(opts: {
  state?: "stopped" | "starting" | "running" | "stopping" | "exited";
  statusSeq: number;
  healthSeq: number;
  pid?: number | null;
  exitCode?: number | null;
  lastError?: string | null;
  reach?: "unknown" | "reachable" | "unreachable";
  activeConnections?: string;
  currentJobId?: string | null;
  uptimeSeconds?: string;
  logs?: string[];
  tlsEnabled?: boolean;
  tlsCertPath?: string | null;
  tlsKeyPath?: string | null;
  workersReach?: "unknown" | "reachable" | "unreachable";
  workers?: Array<{
    workerName: string;
    difficulty: number;
    sharesAccepted: number;
    sharesRejected: number;
    connectedSecs: number;
    extranonceSubscribed?: boolean;
    idleSecs?: number;
  }>;
  bannedIps?: number;
}): StratumSnapshot {
  const reach = opts.reach ?? "unknown";
  const kind = reach === "unreachable" ? "unavailable" : "unknown";
  return {
    process: {
      state: opts.state ?? "stopped",
      pid: opts.pid ?? null,
      exitCode:
        opts.exitCode !== undefined
          ? opts.exitCode
          : opts.state === "exited"
            ? 0
            : null,
      lastError: opts.lastError ?? null,
      logs: opts.logs ?? [],
      statusSeq: opts.statusSeq,
    },
    health: {
      reach,
      status: reach === "reachable" ? field("value", "healthy") : field(kind),
      uptimeSeconds:
        opts.uptimeSeconds !== undefined ? field("value", opts.uptimeSeconds) : field(kind),
      activeConnections:
        opts.activeConnections !== undefined
          ? field("value", opts.activeConnections)
          : field(kind),
      currentJobId:
        opts.currentJobId !== undefined
          ? opts.currentJobId === null
            ? field("value", undefined)
            : field("value", opts.currentJobId)
          : field(kind),
      tlsEnabled:
        opts.tlsEnabled !== undefined
          ? field("value", opts.tlsEnabled ? "true" : "false")
          : field(kind),
      timestamp: reach === "reachable" ? field("value", "2026-11-22T22:00:00Z") : field(kind),
      detail: null,
    },
    healthSeq: opts.healthSeq,
    workers: {
      reach: opts.workersReach ?? reach,
      workers: (opts.workers ?? []).map((w) => ({
        ...w,
        extranonceSubscribed: w.extranonceSubscribed ?? false,
      })),
      bannedIps: opts.bannedIps ?? 0,
      detail: null,
    },
    config:
      opts.state === "running"
        ? {
            binary: "/usr/local/bin/kovanica-stratum",
            binarySha256: "deadbeef",
            listenAddr: "127.0.0.1:3333",
            bindHost: "127.0.0.1",
            bindPort: 3333,
            rpcUrl: "http://127.0.0.1:8545",
            metricsAddr: "127.0.0.1:9090",
            healthUrl: "http://127.0.0.1:9090/health",
            workersUrl: "http://127.0.0.1:9090/workers",
            chainId: 2,
            difficulty: 1,
            tlsEnabled: opts.tlsEnabled ?? false,
            tlsCertPath: opts.tlsCertPath ?? null,
            tlsKeyPath: opts.tlsKeyPath ?? null,
            tlsSelfSigned: false,
            vardiffEnabled: false,
            vardiffMinDifficulty: null,
            vardiffMaxDifficulty: null,
            vardiffTargetShareSecs: null,
            banThresholdInvalidShares: null,
            banDurationSecs: null,
          }
        : null,
    stopGraceSecs: 10,
  };
}

function harness(opts?: { copyText?: (text: string) => Promise<void> }) {
  const defs: Array<[string, string]> = [
    ["stratum-binary-path", "input"],
    ["stratum-bind-host", "input"],
    ["stratum-bind-port", "input"],
    ["stratum-rpc-url", "input"],
    ["stratum-metrics-addr", "input"],
    ["stratum-chain-id", "input"],
    ["stratum-difficulty", "input"],
    ["stratum-tls-toggle", "input"],
    ["stratum-tls-self-signed", "input"],
    ["stratum-tls-cert-path", "input"],
    ["stratum-tls-key-path", "input"],
    ["stratum-vardiff-toggle", "input"],
    ["stratum-vardiff-min", "input"],
    ["stratum-vardiff-max", "input"],
    ["stratum-vardiff-target-secs", "input"],
    ["stratum-ban-threshold", "input"],
    ["stratum-ban-duration-secs", "input"],
    ["stratum-check-button", "button"],
    ["stratum-start-button", "button"],
    ["stratum-restart-button", "button"],
    ["stratum-stop-button", "button"],
    ["stratum-export-diagnostics-button", "button"],
    ["stratum-alerts", "div"],
    ["stratum-diagnostics-status", "p"],
    ["stratum-status-badge", "span"],
    ["stratum-error", "p"],
    ["stratum-summary", "p"],
    ["stratum-process-readout", "dl"],
    ["stratum-health-readout", "dl"],
    ["stratum-workers-readout", "dl"],
    ["stratum-log-viewer", "div"],
  ];
  const nodes = new Map(defs.map(([id, tag]) => [id, element(tag, id)]));
  nodes.get("stratum-bind-host")!.value = "127.0.0.1";
  nodes.get("stratum-bind-port")!.value = "3333";
  nodes.get("stratum-rpc-url")!.value = "http://127.0.0.1:8545";
  nodes.get("stratum-metrics-addr")!.value = "127.0.0.1:9090";
  nodes.get("stratum-chain-id")!.value = "2";
  nodes.get("stratum-difficulty")!.value = "1";
  nodes.get("stratum-vardiff-min")!.value = "0.25";
  nodes.get("stratum-vardiff-max")!.value = "64";
  nodes.get("stratum-vardiff-target-secs")!.value = "15";
  nodes.get("stratum-start-button")!.disabled = true;
  nodes.get("stratum-restart-button")!.disabled = true;
  nodes.get("stratum-stop-button")!.disabled = true;
  nodes.get("stratum-alerts")!.hidden = true;
  nodes.get("stratum-diagnostics-status")!.hidden = true;
  nodes.get("stratum-error")!.hidden = true;

  const listeners: Record<string, Array<() => void>> = {};
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const pending: Pending[] = [];

  const document = {
    hidden: false,
    querySelector(selector: string) {
      return nodes.get(selector.slice(1)) ?? null;
    },
    createElement(tag: string) {
      return element(tag);
    },
    addEventListener(type: string, listener: () => void) {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners[type] = (listeners[type] ?? []).filter((item) => item !== listener);
    },
  };
  const window = {
    setInterval(handler: () => void) {
      const id = nextTimer++;
      timers.set(id, handler);
      return id;
    },
    clearInterval(id: number) {
      timers.delete(id);
    },
    addEventListener(type: string, listener: () => void) {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners[type] = (listeners[type] ?? []).filter((item) => item !== listener);
    },
    dispatch(type: string) {
      for (const listener of listeners[type] ?? []) listener();
    },
  };
  const invoke = (command: string, args?: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      pending.push({ command, args, resolve, reject });
    });

  const dispose = mountStratumApp({ invoke, document, window }, opts);

  function take(command: string): Pending {
    const idx = pending.findIndex((p) => p.command === command);
    assert.notEqual(
      idx,
      -1,
      `missing invoke ${command}; have ${pending.map((p) => p.command).join(",")}`,
    );
    return pending.splice(idx, 1)[0];
  }

  async function flush() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }

  return { nodes, document, window, timers, pending, take, flush, dispose };
}

test("Stratum form validation and payload conversion enforce required fields and TLS rules", () => {
  const base: StratumFormInput = {
    binary: "/usr/local/bin/kovanica-stratum",
    bindHost: "127.0.0.1",
    bindPort: "3333",
    rpcUrl: "http://127.0.0.1:8545",
    metricsAddr: "127.0.0.1:9090",
    chainId: "2",
    difficulty: "1.5",
    tlsEnabled: false,
    tlsCertPath: "",
    tlsKeyPath: "",
    tlsSelfSigned: false,
  };
  assert.equal(validateStratumForm(base), null);
  assert.equal(toStratumPayload(base).bindPort, 3333);
  assert.equal(toStratumPayload(base).difficulty, 1.5);
  assert.equal(toStratumPayload(base).tlsCertPath, null);

  assert.match(validateStratumForm({ ...base, binary: "" })!, /executable/i);
  assert.match(validateStratumForm({ ...base, bindPort: "0" })!, /port/i);
  assert.match(validateStratumForm({ ...base, bindPort: "70000" })!, /port/i);
  assert.match(validateStratumForm({ ...base, rpcUrl: "ws://127.0.0.1:8545" })!, /http/i);
  assert.match(validateStratumForm({ ...base, chainId: "99" })!, /Chain ID/i);
  assert.match(validateStratumForm({ ...base, difficulty: "-1" })!, /difficulty/i);
  assert.match(validateStratumForm({ ...base, tlsEnabled: true })!, /TLS is enabled/i);

  assert.equal(
    validateStratumForm({
      ...base,
      tlsEnabled: true,
      tlsCertPath: "/etc/stratum/cert.pem",
      tlsKeyPath: "/etc/stratum/key.pem",
    }),
    null,
  );
  assert.equal(
    validateStratumForm({
      ...base,
      tlsEnabled: true,
      tlsSelfSigned: true,
    }),
    null,
  );

  assert.equal(stratumStatusLabel("running"), "Running");
  assert.equal(stratumStatusLabel("stopped"), "Stopped");
  assert.equal(stratumStatusLabel("exited"), "Exited");

  // VarDiff & ban rules
  assert.match(
    validateStratumForm({
      ...base,
      vardiffEnabled: true,
      vardiffMinDifficulty: "64",
      vardiffMaxDifficulty: "8",
      vardiffTargetShareSecs: "15",
    })!,
    /must not exceed maximum/i,
  );
  assert.match(
    validateStratumForm({
      ...base,
      banThresholdInvalidShares: "5",
      banDurationSecs: "",
    })!,
    /Ban duration seconds is required/i,
  );
  const fullPayload = toStratumPayload({
    ...base,
    vardiffEnabled: true,
    vardiffMinDifficulty: "0.5",
    vardiffMaxDifficulty: "32",
    vardiffTargetShareSecs: "15",
    banThresholdInvalidShares: "5",
    banDurationSecs: "300",
  });
  assert.equal(fullPayload.vardiffEnabled, true);
  assert.equal(fullPayload.vardiffMinDifficulty, 0.5);
  assert.equal(fullPayload.vardiffMaxDifficulty, 32);
  assert.equal(fullPayload.vardiffTargetShareSecs, 15);
  assert.equal(fullPayload.banThresholdInvalidShares, 5);
  assert.equal(fullPayload.banDurationSecs, 300);
});

test("HTML and CSS contain Stratum Gateway supervisor controls and status badge styling", () => {
  assert.match(html, /id="stratum-panel"/);
  assert.match(html, /id="stratum-status-badge"/);
  assert.match(html, /id="stratum-start-button"/);
  assert.match(html, /id="stratum-restart-button"/);
  assert.match(html, /id="stratum-stop-button"/);
  assert.match(html, /id="stratum-tls-toggle"/);
  assert.match(html, /id="stratum-vardiff-toggle"/);
  assert.match(html, /id="stratum-ban-threshold"/);
  assert.match(html, /id="stratum-workers-readout"/);
  assert.match(html, /id="stratum-log-viewer"/);
  assert.match(html, /id="stratum-alerts"/);
  assert.match(html, /id="stratum-export-diagnostics-button"/);
  assert.match(css, /\.status-badge\[data-state="running"\]/);
  assert.match(css, /\.stratum-alerts\[data-severity="critical"\]/);
});

test("TLS toggle enables cert/key fields and editing invalidates approval", async () => {
  const world = harness();
  world.take("stratum_status").resolve(sampleSnapshot({ statusSeq: 1, healthSeq: 1 }));
  await world.flush();

  assert.equal(world.nodes.get("stratum-tls-cert-path")!.disabled, true);
  assert.equal(world.nodes.get("stratum-tls-key-path")!.disabled, true);
  assert.equal(world.nodes.get("stratum-tls-self-signed")!.disabled, true);

  world.nodes.get("stratum-binary-path")!.value = "/usr/local/bin/kovanica-stratum";
  world.nodes.get("stratum-check-button")!.dispatch("click");
  const inspect = world.take("stratum_inspect");
  inspect.resolve({
    binary: "/usr/local/bin/kovanica-stratum",
    binarySha256: "abc123",
    listenAddr: "127.0.0.1:3333",
    bindHost: "127.0.0.1",
    bindPort: 3333,
    rpcUrl: "http://127.0.0.1:8545",
    metricsAddr: "127.0.0.1:9090",
    healthUrl: "http://127.0.0.1:9090/health",
    chainId: 2,
    difficulty: 1,
    tlsEnabled: false,
    tlsCertPath: null,
    tlsKeyPath: null,
    tlsSelfSigned: false,
  });
  await world.flush();
  assert.equal(world.nodes.get("stratum-start-button")!.disabled, false);
  assert.match(world.nodes.get("stratum-summary")!.textContent, /abc123/);

  // Toggling TLS enables TLS inputs and clears start approval
  world.nodes.get("stratum-tls-toggle")!.checked = true;
  world.nodes.get("stratum-tls-toggle")!.dispatch("change");
  assert.equal(world.nodes.get("stratum-tls-cert-path")!.disabled, false);
  assert.equal(world.nodes.get("stratum-tls-key-path")!.disabled, false);
  assert.equal(world.nodes.get("stratum-tls-self-signed")!.disabled, false);
  assert.equal(world.nodes.get("stratum-start-button")!.disabled, true);
  assert.equal(world.nodes.get("stratum-summary")!.textContent, "");

  world.dispose();
});

test("start, live health polling, restart, stop, and stale snapshot rejection work end-to-end", async () => {
  const world = harness();
  world.take("stratum_status").resolve(sampleSnapshot({ statusSeq: 1, healthSeq: 1 }));
  await world.flush();
  assert.equal(world.nodes.get("stratum-status-badge")!.textContent, "Stopped");
  assert.equal(world.nodes.get("stratum-status-badge")!.dataset.state, "stopped");

  world.nodes.get("stratum-binary-path")!.value = "/usr/local/bin/kovanica-stratum";
  world.nodes.get("stratum-check-button")!.dispatch("click");
  world.take("stratum_inspect").resolve({
    binary: "/usr/local/bin/kovanica-stratum",
    binarySha256: "sha256hex",
    listenAddr: "127.0.0.1:3333",
    bindHost: "127.0.0.1",
    bindPort: 3333,
    rpcUrl: "http://127.0.0.1:8545",
    metricsAddr: "127.0.0.1:9090",
    healthUrl: "http://127.0.0.1:9090/health",
    chainId: 2,
    difficulty: 1,
    tlsEnabled: false,
    tlsCertPath: null,
    tlsKeyPath: null,
    tlsSelfSigned: false,
  });
  await world.flush();

  // Start
  world.nodes.get("stratum-start-button")!.dispatch("click");
  world.take("stratum_start").resolve(
    sampleSnapshot({
      state: "running",
      statusSeq: 2,
      healthSeq: 2,
      pid: 7001,
      logs: ["started stratum pid 7001"],
    }),
  );
  await world.flush();
  assert.equal(world.nodes.get("stratum-status-badge")!.textContent, "Running");
  assert.equal(world.nodes.get("stratum-start-button")!.disabled, true);
  assert.equal(world.nodes.get("stratum-restart-button")!.disabled, false);
  assert.equal(world.nodes.get("stratum-stop-button")!.disabled, false);
  assert.equal(readout(world.nodes.get("stratum-process-readout")!).PID, "7001");

  // Poll triggers status + health refresh when running and visible
  const tick = world.timers.get([...world.timers.keys()][0])!;
  tick();
  const staleStatus = world.take("stratum_status");
  const healthPoll = world.take("stratum_refresh");
  healthPoll.resolve(
    sampleSnapshot({
      state: "running",
      statusSeq: 2,
      healthSeq: 3,
      pid: 7001,
      reach: "reachable",
      uptimeSeconds: "120",
      activeConnections: "4",
      currentJobId: "job-0009",
      tlsEnabled: false,
      logs: ["started stratum pid 7001", "miner connected"],
      workersReach: "reachable",
      bannedIps: 1,
      workers: [
        {
          workerName: "rig-alpha.01",
          difficulty: 4.5,
          sharesAccepted: 120,
          sharesRejected: 2,
          connectedSecs: 3600,
          extranonceSubscribed: true,
        },
        {
          workerName: "rig-beta.02",
          difficulty: 2,
          sharesAccepted: 45,
          sharesRejected: 0,
          connectedSecs: 900,
          extranonceSubscribed: false,
        },
      ],
    }),
  );
  await world.flush();
  const hRows = readout(world.nodes.get("stratum-health-readout")!);
  assert.equal(hRows.Status, "healthy");
  assert.equal(hRows["Active miners"], "4");
  assert.equal(hRows["Current job"], "job-0009");
  assert.equal(hRows["Uptime (s)"], "120");
  const wRows = readout(world.nodes.get("stratum-workers-readout")!);
  assert.equal(wRows["Workers endpoint"], "reachable");
  assert.equal(wRows["Active workers"], "2");
  assert.equal(wRows["Banned IPs"], "1");
  assert.equal(
    wRows["rig-alpha.01"],
    "diff=4.5 accepted=120 rejected=2 connected=3600s [xnsub]",
  );
  assert.equal(
    wRows["rig-beta.02"],
    "diff=2 accepted=45 rejected=0 connected=900s",
  );

  // Restart produces a new PID
  world.nodes.get("stratum-restart-button")!.dispatch("click");
  world.take("stratum_restart").resolve(
    sampleSnapshot({
      state: "running",
      statusSeq: 4,
      healthSeq: 4,
      pid: 7002,
      logs: ["started stratum pid 7002"],
    }),
  );
  await world.flush();
  assert.equal(readout(world.nodes.get("stratum-process-readout")!).PID, "7002");

  // Stale status from old sequence 2 must not overwrite PID 7002
  staleStatus.resolve(
    sampleSnapshot({
      state: "running",
      statusSeq: 2,
      healthSeq: 3,
      pid: 7001,
    }),
  );
  await world.flush();
  assert.equal(readout(world.nodes.get("stratum-process-readout")!).PID, "7002");

  // Stop
  world.nodes.get("stratum-stop-button")!.dispatch("click");
  world.take("stratum_stop").resolve(
    sampleSnapshot({
      state: "exited",
      statusSeq: 5,
      healthSeq: 5,
      reach: "unreachable",
      logs: ["started stratum pid 7002", "stratum exited code 0"],
    }),
  );
  await world.flush();
  assert.equal(world.nodes.get("stratum-status-badge")!.textContent, "Exited");
  assert.equal(world.nodes.get("stratum-stop-button")!.disabled, true);
  assert.equal(world.nodes.get("stratum-restart-button")!.disabled, true);
  assert.equal(world.nodes.get("stratum-start-button")!.disabled, false);

  world.window.dispatch("beforeunload");
  assert.equal(world.timers.size, 0);
  world.dispose();
});

test("evaluateStratumAlerts detects crash, high IP bans, missing job, and idle workers in severity order", () => {
  const healthySnap = sampleSnapshot({
    state: "running",
    statusSeq: 1,
    healthSeq: 1,
    reach: "reachable",
    activeConnections: "1",
    currentJobId: "job-100",
    bannedIps: 4,
    workers: [
      {
        workerName: "rig-1",
        difficulty: 2,
        sharesAccepted: 10,
        sharesRejected: 0,
        connectedSecs: 400,
        idleSecs: 299,
      },
    ],
  });
  assert.deepEqual(
    evaluateStratumAlerts(healthySnap.process, healthySnap.health, healthySnap.workers),
    [],
  );

  const alertedSnap = sampleSnapshot({
    state: "exited",
    exitCode: 137,
    lastError: "killed with token=supersecret",
    statusSeq: 2,
    healthSeq: 2,
    reach: "reachable",
    activeConnections: "2",
    currentJobId: null,
    bannedIps: 5,
    workers: [
      {
        workerName: "rig-stale",
        difficulty: 2,
        sharesAccepted: 1,
        sharesRejected: 0,
        connectedSecs: 900,
        idleSecs: 300,
      },
    ],
  });
  const alerts = evaluateStratumAlerts(
    alertedSnap.process,
    alertedSnap.health,
    alertedSnap.workers,
  );
  assert.equal(alerts.length, 4);
  assert.deepEqual(
    alerts.map((a) => [a.id, a.severity]),
    [
      ["stratum-crashed", "critical"],
      ["high-ip-bans", "warning"],
      ["no-current-job", "warning"],
      ["idle-workers", "info"],
    ],
  );
  assert.doesNotMatch(alerts[0].message, /supersecret/);
  assert.match(alerts[0].message, /\[REDACTED\]/);
  assert.match(alerts[3].message, /rig-stale/);
});

test("buildSanitizedStratumDiagnostics redacts PEM paths and secrets and keeps last 200 log lines", () => {
  const logs = Array.from({ length: 250 }, (_, idx) => {
    if (idx === 248) {
      return "launch --tls-cert /etc/kovanica/secret_cert.pem --tls-key /etc/kovanica/private.key Bearer eyJhbGciOiJIUzI1NiJ9";
    }
    if (idx === 249) {
      return "rpc=http://admin:hunter2@127.0.0.1:8545 api_key=sk_live_999999";
    }
    return `line-${idx}`;
  });

  const snap = sampleSnapshot({
    state: "running",
    statusSeq: 3,
    healthSeq: 3,
    reach: "reachable",
    activeConnections: "1",
    currentJobId: "job-7",
    tlsEnabled: true,
    tlsCertPath: "/etc/kovanica/tls_cert.pem",
    tlsKeyPath: "/etc/kovanica/tls_key.pem",
    logs,
  });

  const bundle = buildSanitizedStratumDiagnostics({
    status: snap.process,
    health: snap.health,
    workers: snap.workers,
    logs,
    config: snap.config,
    generatedAt: "2026-11-23T09:00:00.000Z",
  });

  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.source, "node-desktop");
  assert.equal(bundle.logs.length, 200);
  assert.equal(bundle.logs[0], "line-50");
  assert.doesNotMatch(serialized, /tls_cert\.pem/);
  assert.doesNotMatch(serialized, /tls_key\.pem/);
  assert.doesNotMatch(serialized, /secret_cert\.pem/);
  assert.doesNotMatch(serialized, /private\.key/);
  assert.doesNotMatch(serialized, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(serialized, /hunter2/);
  assert.doesNotMatch(serialized, /sk_live_999999/);
  assert.equal("tlsCertPath" in (bundle.config ?? {}), false);
  assert.equal("tlsKeyPath" in (bundle.config ?? {}), false);
});

test("Stratum UI renders alert banner and exports sanitized diagnostics JSON on button click", async () => {
  let copiedJson = "";
  const world = harness({
    copyText: async (text) => {
      copiedJson = text;
    },
  });

  world.take("stratum_status").resolve(
    sampleSnapshot({
      state: "exited",
      exitCode: 2,
      lastError: "failed to load /etc/stratum/key.pem",
      statusSeq: 1,
      healthSeq: 1,
      reach: "reachable",
      activeConnections: "1",
      currentJobId: null,
      bannedIps: 6,
      logs: ["boot --tls-key /etc/stratum/key.pem", "exited with code 2"],
    }),
  );
  await world.flush();

  const alertsEl = world.nodes.get("stratum-alerts")!;
  assert.equal(alertsEl.hidden, false);
  assert.equal(alertsEl.dataset.severity, "critical");
  assert.equal(alertsEl.children.length, 3);
  assert.match(alertsEl.children[0].textContent, /^\[CRITICAL\]/);
  assert.doesNotMatch(alertsEl.children[0].textContent, /key\.pem/);

  world.nodes.get("stratum-export-diagnostics-button")!.dispatch("click");
  await world.flush();

  assert.notEqual(copiedJson, "");
  assert.doesNotMatch(copiedJson, /key\.pem/);
  const parsed = JSON.parse(copiedJson) as {
    source: string;
    alerts: Array<{ id: string }>;
    logs: string[];
  };
  assert.equal(parsed.source, "node-desktop");
  assert.equal(parsed.alerts.length, 3);
  assert.equal(parsed.logs.length, 2);
  assert.match(
    world.nodes.get("stratum-diagnostics-status")!.textContent,
    /Copied sanitized diagnostics JSON/,
  );

  world.dispose();
});

test("probeStratumUpstreamRpc measures kovanica_chainId reachability/latency and formatRpcProbeResult sanitizes output", async () => {
  const mockOkFetch: typeof fetch = (async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    assert.equal(payload.method, "kovanica_chainId");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "2" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const okProbe = await probeStratumUpstreamRpc(
    "http://operator:supersecret@127.0.0.1:8545",
    mockOkFetch,
  );
  assert.equal(okProbe.ok, true);
  assert.equal(okProbe.chainId, "2");
  assert.equal(okProbe.error, null);
  assert.ok(okProbe.latencyMs >= 0);
  assert.doesNotMatch(okProbe.url, /supersecret/);
  assert.match(okProbe.url, /^http:\/\/127\.0\.0\.1:8545\/?$/);
  const okFormatted = formatRpcProbeResult(okProbe);
  assert.match(okFormatted, /Upstream RPC reachable/);
  assert.match(okFormatted, /chainId=2/);
  assert.doesNotMatch(okFormatted, /supersecret/);

  const mockHttpErrFetch: typeof fetch = (async () =>
    new Response("Bad Gateway", { status: 502 })) as typeof fetch;
  const httpErrProbe = await probeStratumUpstreamRpc(
    "http://127.0.0.1:8545",
    mockHttpErrFetch,
  );
  assert.equal(httpErrProbe.ok, false);
  assert.equal(httpErrProbe.chainId, null);
  assert.equal(httpErrProbe.error, "HTTP 502");

  const mockRpcErrFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "auth failed Bearer secret_tok_999" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  const rpcErrProbe = await probeStratumUpstreamRpc(
    "http://127.0.0.1:8545",
    mockRpcErrFetch,
  );
  assert.equal(rpcErrProbe.ok, false);
  assert.doesNotMatch(rpcErrProbe.error ?? "", /secret_tok_999/);
  assert.match(rpcErrProbe.error ?? "", /\[REDACTED\]/);

  const mockThrowFetch: typeof fetch = (async () => {
    throw new Error("ECONNREFUSED http://admin:hunter2@127.0.0.1:8545");
  }) as typeof fetch;
  const downProbe = await probeStratumUpstreamRpc(
    "http://admin:hunter2@127.0.0.1:8545",
    mockThrowFetch,
  );
  assert.equal(downProbe.ok, false);
  assert.doesNotMatch(downProbe.url, /hunter2/);
  assert.doesNotMatch(downProbe.error ?? "", /hunter2/);
  const downFormatted = formatRpcProbeResult(downProbe);
  assert.match(downFormatted, /Upstream RPC unreachable/);
  assert.doesNotMatch(downFormatted, /hunter2/);

  let invalidCalled = false;
  const invalidProbe = await probeStratumUpstreamRpc("ws://127.0.0.1:8545", (async () => {
    invalidCalled = true;
    return new Response("");
  }) as typeof fetch);
  assert.equal(invalidCalled, false);
  assert.equal(invalidProbe.ok, false);
  assert.match(invalidProbe.error ?? "", /http/i);
});
