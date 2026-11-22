import {
  DEFAULT_STRATUM_HEALTH_URL,
  fetchStratumHealth,
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

  function render(): void {
    rowsList!.replaceChildren();
    if (state.kind === "idle") {
      stateText!.textContent = `Idle · ${state.endpoint}`;
      stateText!.dataset.state = "idle";
      errorText!.hidden = true;
      errorText!.textContent = "";
      return;
    }
    if (state.kind === "loading") {
      stateText!.textContent = `Checking ${state.endpoint}…`;
      stateText!.dataset.state = "loading";
      errorText!.hidden = true;
      errorText!.textContent = "";
      return;
    }
    if (state.kind === "offline") {
      stateText!.textContent = `Offline · ${state.endpoint}`;
      stateText!.dataset.state = "offline";
      errorText!.hidden = false;
      errorText!.textContent = state.error;
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
  }

  async function refresh(): Promise<void> {
    refreshBtn!.disabled = true;
    state = { kind: "loading", endpoint: currentEndpoint };
    render();
    try {
      const health = await fetchStratumHealth(currentEndpoint, {
        fetchImpl: options.fetchImpl,
      });
      state = { kind: "online", endpoint: currentEndpoint, health };
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
