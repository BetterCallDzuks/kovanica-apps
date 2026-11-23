import {
  DEFAULT_STRATUM_HEALTH_URL,
  fetchStratumHealth,
  fetchStratumWorkers,
  formatUptime,
  normalizeStratumHealthUrl,
  STRATUM_STORAGE_KEY,
  stratumHealthRows,
  type StratumTelemetryState,
} from "./stratum";

export interface StratumPanelController {
  refresh: () => Promise<void>;
  getState: () => StratumTelemetryState;
}

function loadSavedUrl(storage: Storage | null): string {
  if (!storage) return DEFAULT_STRATUM_HEALTH_URL;
  try {
    const saved = storage.getItem(STRATUM_STORAGE_KEY);
    if (!saved) return DEFAULT_STRATUM_HEALTH_URL;
    return normalizeStratumHealthUrl(saved);
  } catch {
    return DEFAULT_STRATUM_HEALTH_URL;
  }
}

function persistUrl(storage: Storage | null, url: string): void {
  if (!storage) return;
  try {
    storage.setItem(STRATUM_STORAGE_KEY, url);
  } catch {
    // Ignore storage quota or privacy-mode failures.
  }
}

/**
 * Mounts the Stratum Gateway Health & Telemetry panel onto `#stratum-panel`.
 * No-ops gracefully when the DOM lacks the panel (e.g. minimal unit-test fixtures).
 */
export function mountStratumPanel(options: {
  fetchImpl?: typeof fetch;
  storage?: Storage | null;
} = {}): StratumPanelController | null {
  const urlInput = document.querySelector<HTMLInputElement>("#stratum-url");
  const saveBtn = document.querySelector<HTMLButtonElement>("#stratum-save");
  const resetBtn = document.querySelector<HTMLButtonElement>("#stratum-reset");
  const refreshBtn = document.querySelector<HTMLButtonElement>("#stratum-refresh");
  const stateText = document.querySelector<HTMLParagraphElement>("#stratum-state");
  const errorText = document.querySelector<HTMLParagraphElement>("#stratum-error");
  const rowsList = document.querySelector<HTMLDListElement>("#stratum-rows");
  const workersSection = document.querySelector<HTMLElement>("#stratum-workers-section");
  const workersEmpty = document.querySelector<HTMLElement>("#stratum-workers-empty");
  const workersTable = document.querySelector<HTMLTableElement>("#stratum-workers-table");
  const workersBody = document.querySelector<HTMLTableSectionElement>("#stratum-workers-body");

  if (!urlInput || !saveBtn || !resetBtn || !refreshBtn || !stateText || !errorText || !rowsList) {
    return null;
  }

  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage !== "undefined"
        ? localStorage
        : null;

  let currentEndpoint = loadSavedUrl(storage);
  let state: StratumTelemetryState = { kind: "idle", endpoint: currentEndpoint };

  urlInput.value = currentEndpoint;

  function clearWorkers(): void {
    workersBody?.replaceChildren();
    if (workersSection) workersSection.hidden = true;
    if (workersTable) workersTable.hidden = true;
    if (workersEmpty) workersEmpty.hidden = false;
  }

  function render(): void {
    rowsList!.replaceChildren();
    if (state.kind === "idle") {
      stateText!.textContent = `Idle · ${state.endpoint}`;
      stateText!.dataset.state = "idle";
      errorText!.hidden = true;
      errorText!.textContent = "";
      clearWorkers();
      return;
    }
    if (state.kind === "loading") {
      stateText!.textContent = `Checking ${state.endpoint}…`;
      stateText!.dataset.state = "loading";
      errorText!.hidden = true;
      errorText!.textContent = "";
      clearWorkers();
      return;
    }
    if (state.kind === "offline") {
      stateText!.textContent = `Offline · ${state.endpoint}`;
      stateText!.dataset.state = "offline";
      errorText!.hidden = false;
      errorText!.textContent = state.error;
      clearWorkers();
      return;
    }
    stateText!.textContent = `Online (${state.health.status}) · ${state.endpoint}`;
    stateText!.dataset.state = "online";
    errorText!.hidden = true;
    errorText!.textContent = "";
    for (const row of stratumHealthRows(state.health)) {
      const dt = document.createElement("dt");
      dt.textContent = row.label;
      const dd = document.createElement("dd");
      dd.textContent = row.value;
      rowsList!.append(dt, dd);
    }

    workersBody?.replaceChildren();
    if (workersSection) {
      workersSection.hidden = false;
    }
    if (state.workers.length === 0) {
      if (workersEmpty) workersEmpty.hidden = false;
      if (workersTable) workersTable.hidden = true;
    } else {
      if (workersEmpty) workersEmpty.hidden = true;
      if (workersTable) workersTable.hidden = false;
      if (workersBody) {
        for (const worker of state.workers) {
          const tr = document.createElement("tr");

          const nameTd = document.createElement("td");
          nameTd.textContent = worker.worker_name;

          const diffTd = document.createElement("td");
          diffTd.textContent = String(worker.difficulty);

          const acceptedTd = document.createElement("td");
          acceptedTd.textContent = String(worker.shares_accepted);

          const rejectedTd = document.createElement("td");
          rejectedTd.textContent = String(worker.shares_rejected);

          const connectedTd = document.createElement("td");
          connectedTd.textContent = `${formatUptime(worker.connected_secs)} (${worker.connected_secs}s)`;

          tr.append(nameTd, diffTd, acceptedTd, rejectedTd, connectedTd);
          workersBody.append(tr);
        }
      }
    }
  }

  async function refresh(): Promise<void> {
    refreshBtn!.disabled = true;
    state = { kind: "loading", endpoint: currentEndpoint };
    render();
    try {
      const [health, workersReport] = await Promise.all([
        fetchStratumHealth(currentEndpoint, {
          fetchImpl: options.fetchImpl,
        }),
        fetchStratumWorkers(currentEndpoint, options.fetchImpl).catch(() => null),
      ]);
      state = {
        kind: "online",
        endpoint: currentEndpoint,
        health,
        workers: workersReport ? workersReport.workers : [],
      };
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Stratum gateway is offline or unreachable.";
      state = { kind: "offline", endpoint: currentEndpoint, error: message };
    } finally {
      refreshBtn!.disabled = false;
      render();
    }
  }

  saveBtn.addEventListener("click", () => {
    try {
      currentEndpoint = normalizeStratumHealthUrl(urlInput.value);
      urlInput.value = currentEndpoint;
      persistUrl(storage, currentEndpoint);
      void refresh();
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Invalid Stratum health URL.";
      state = { kind: "offline", endpoint: urlInput.value.trim() || currentEndpoint, error: message };
      render();
    }
  });

  resetBtn.addEventListener("click", () => {
    currentEndpoint = DEFAULT_STRATUM_HEALTH_URL;
    urlInput.value = currentEndpoint;
    persistUrl(storage, currentEndpoint);
    void refresh();
  });

  refreshBtn.addEventListener("click", () => {
    void refresh();
  });

  render();

  return {
    refresh,
    getState: () => state,
  };
}
