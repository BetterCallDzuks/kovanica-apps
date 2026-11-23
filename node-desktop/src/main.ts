import { invoke } from "@tauri-apps/api/core";
import { mountStratumApp } from "./stratum.ts";
import { mountNodeApp } from "./ui.ts";

const host = {
  invoke: (command: string, args?: Record<string, unknown>) => invoke(command, args),
  document,
  window,
};

mountNodeApp(host);
mountStratumApp(host);
