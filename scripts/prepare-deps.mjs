#!/usr/bin/env node
/**
 * prepare-deps.mjs — Materialize pinned external dependencies for kovanica-apps.
 *
 * kovanica-apps consumes `kovanica-sdk` and `kovanica-l1` packages via `file:`
 * references that resolve to directories inside this repo:
 *   - wallet-web/browser-extension: `file:../../kovanica-sdk` → kovanica-apps/kovanica-sdk/
 *   - desktop: `file:../../kovanica-l1/packages/api-client` → kovanica-apps/kovanica-l1/packages/api-client/
 *              `file:../../kovanica-l1/packages/comms` → kovanica-apps/kovanica-l1/packages/comms/
 *              `file:../../kovanica-l1/packages/signer` → kovanica-apps/kovanica-l1/packages/signer/
 *
 * A bare `git clone` of only `kovanica-apps` does not include those directories,
 * so `npm install` in any subdirectory would fail. This script clones the exact
 * pinned SHAs, builds them, and places them under kovanica-apps/ so the `file:`
 * references resolve. Modeled on kovanica-playground/scripts/prepare-sdk.mjs.
 *
 * Notes:
 *   - kovanica-sdk is a standalone Node.js package: clone, npm install, npm run build.
 *   - kovanica-l1 is a Rust workspace (no root package.json). We clone it but skip
 *     npm install at the root; instead we copy the individual TS packages under
 *     kovanica-l1/packages/ into place.
 *   - After provisioning, npm install is run in each app so `file:` references
 *     resolve correctly for TypeScript.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APPS_ROOT = resolve(__dirname, ".."); // kovanica-apps repo root

const pkg = JSON.parse(readFileSync(join(APPS_ROOT, "package.json"), "utf8"));

// Pinned revisions — update these when rolling to a new SDK / L1 release.
const SDK_PINNED_SHA = pkg?.kovanicaSdk?.testedRevision;
const L1_PINNED_SHA = pkg?.kovanicaL1?.testedRevision;

const SDK_REPO_URL = pkg?.kovanicaSdk?.repository || "https://github.com/BetterCallDzuks/kovanica-sdk";
const L1_REPO_URL = pkg?.kovanicaL1?.repository || "https://github.com/BetterCallDzuks/kovanica-l1";

// Expected locations (matching the `file:` references in app package.json files)
const SDK_DIR = join(APPS_ROOT, "kovanica-sdk");
const L1_DIR = join(APPS_ROOT, "kovanica-l1");

// Packages from kovanica-l1/packages/ that are consumed by kovanica-apps
const L1_PACKAGE_NAMES = ["api-client", "comms", "signer"];

const APPS_TO_INSTALL = ["wallet-web", "browser-extension", "desktop"];

const cleanEnv = { ...process.env };
delete cleanEnv.npm_config_allow_scripts;
delete cleanEnv.NPM_CONFIG_ALLOW_SCRIPTS;

function fail(msg) {
  console.error(`[prepare-deps] ${msg}`);
  process.exit(1);
}

if (!SDK_PINNED_SHA || !/^[0-9a-f]{40}$/.test(SDK_PINNED_SHA)) {
  fail(`Invalid or missing kovanicaSdk.testedRevision: ${SDK_PINNED_SHA}`);
}
if (!L1_PINNED_SHA || !/^[0-9a-f]{40}$/.test(L1_PINNED_SHA)) {
  fail(`Invalid or missing kovanicaL1.testedRevision: ${L1_PINNED_SHA}`);
}

/** Clone a Node.js package repo at a pinned SHA, npm install + build, copy to targetDir. */
function provisionNodePackage(repoUrl, pinnedSha, targetDir) {
  if (existsSync(targetDir)) {
    let head = "";
    try {
      head = execSync(`git -C "${targetDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
      const statusOut = execSync(`git -C "${targetDir}" status --porcelain`, { encoding: "utf8" }).trim();
      if (head === pinnedSha && statusOut.length === 0) {
        console.log(`[prepare-deps] ${targetDir} already at pinned SHA ${pinnedSha}`);
        return;
      }
    } catch {}
  }

  console.log(`[prepare-deps] Cloning ${repoUrl} at ${pinnedSha}...`);
  const cacheDir = join(tmpdir(), `kovanica-deps-${pinnedSha.slice(0, 12)}`);
  if (!existsSync(join(cacheDir, "package.json"))) {
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    execSync(`git clone --no-checkout "${repoUrl}" "${cacheDir}"`, { stdio: "inherit" });
    execSync(`git -C "${cacheDir}" checkout --detach ${pinnedSha}`, { stdio: "inherit" });
  }
  const verifiedHead = execSync(`git -C "${cacheDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
  if (verifiedHead !== pinnedSha) {
    fail(`SHA verification failed: expected ${pinnedSha}, got ${verifiedHead}`);
  }
  execSync("npm install", { cwd: cacheDir, stdio: "inherit", env: cleanEnv });
  execSync("npm run build", { cwd: cacheDir, stdio: "inherit", env: cleanEnv });

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  const entries = ["package.json", "package-lock.json", "dist", "src", "README.md", "LICENSE", "tsconfig.json"];
  for (const entry of entries) {
    const src = join(cacheDir, entry);
    if (existsSync(src)) {
      cpSync(src, join(targetDir, entry), { recursive: true, overwrite: true });
    }
  }
  writeFileSync(join(targetDir, ".tested-revision"), `${pinnedSha}\n`, "utf8");
  console.log(`[prepare-deps] Provisioned ${targetDir} (${pinnedSha})`);
}

/** Provision kovanica-l1 (Rust workspace): clone but skip npm install at root.
 *  Instead, copy the individual TS packages under kovanica-l1/packages/. */
function provisionL1Packages(repoUrl, pinnedSha, targetDir) {
  if (existsSync(targetDir)) {
    let head = "";
    try {
      head = execSync(`git -C "${targetDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
      const statusOut = execSync(`git -C "${targetDir}" status --porcelain`, { encoding: "utf8" }).trim();
      if (head === pinnedSha && statusOut.length === 0) {
        console.log(`[prepare-deps] ${targetDir} already at pinned SHA ${pinnedSha}`);
        return;
      }
    } catch {}
  }

  console.log(`[prepare-deps] Cloning kovanica-l1 at ${pinnedSha}...`);
  const cacheDir = join(tmpdir(), `kovanica-deps-l1-${pinnedSha.slice(0, 12)}`);
  if (!existsSync(join(cacheDir, "Cargo.toml"))) {
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    execSync(`git clone --no-checkout "${repoUrl}" "${cacheDir}"`, { stdio: "inherit" });
    execSync(`git -C "${cacheDir}" checkout --detach ${pinnedSha}`, { stdio: "inherit" });
  }
  const verifiedHead = execSync(`git -C "${cacheDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
  if (verifiedHead !== pinnedSha) {
    fail(`SHA verification failed for kovanica-l1: expected ${pinnedSha}, got ${verifiedHead}`);
  }

  // Copy the whole kovanica-l1 checkout (it's a Rust workspace; no npm install needed)
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // Copy everything from the cache - simpler and more reliable than selective copy
  const cacheEntries = existsSync(cacheDir) ? readdirSync(cacheDir) : [];
  for (const entry of cacheEntries) {
    cpSync(join(cacheDir, entry), join(targetDir, entry), { recursive: true, overwrite: true });
  }

  writeFileSync(join(targetDir, ".tested-revision"), `${pinnedSha}\n`, "utf8");
  console.log(`[prepare-deps] Provisioned ${targetDir} (${pinnedSha})`);
}

/** Run npm install in each app directory so `file:` references resolve. */
function npmInstallInApps() {
  for (const app of APPS_TO_INSTALL) {
    const appDir = join(APPS_ROOT, app);
    if (!existsSync(appDir)) {
      console.log(`[prepare-deps] Skipping ${app}: directory not found`);
      continue;
    }
    console.log(`[prepare-deps] npm install in ${app}...`);
    execSync("npm install", { cwd: appDir, stdio: "inherit", env: cleanEnv });
  }
}

function main() {
  mkdirSync(join(APPS_ROOT, "node_modules"), { recursive: true });

  // 1. Provision kovanica-sdk (standalone Node.js package)
  provisionNodePackage(SDK_REPO_URL, SDK_PINNED_SHA, SDK_DIR);

  // 2. Provision kovanica-l1 (Rust workspace — copy packages/ directory)
  provisionL1Packages(L1_REPO_URL, L1_PINNED_SHA, L1_DIR);

  // 3. Run npm install in each app so `file:` references resolve
  npmInstallInApps();

  console.log("[prepare-deps] All dependencies provisioned successfully.");
}

main();
