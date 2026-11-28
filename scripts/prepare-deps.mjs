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
 * so `npm install` in any subdirectory would fail. This script creates stub packages
 * with type declarations so that `npm install` resolves the `file:` references and
 * TypeScript can typecheck against them.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APPS_ROOT = resolve(__dirname, ".."); // kovanica-apps repo root

const pkg = JSON.parse(readFileSync(join(APPS_ROOT, "package.json"), "utf8"));

const SDK_PINNED_SHA = pkg?.kovanicaSdk?.testedRevision;
const L1_PINNED_SHA = pkg?.kovanicaL1?.testedRevision;

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

/** Create a stub Node.js package at targetDir with the given name. */
function createStubPackage(targetDir, pkgName) {
  const pkgDir = join(targetDir, pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: pkgName,
        version: "0.0.0",
        description: `Stub for ${pkgName}`,
        main: "./index.js",
        types: "./index.d.ts",
        private: true,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(pkgDir, "index.js"), "module.exports = {};\n");
  writeFileSync(
    join(pkgDir, "index.d.ts"),
    "declare const _: any;\nexport = _;\n",
  );
  console.log(`[prepare-deps] Created stub package ${pkgName}`);
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

  // Create stub for kovanica-sdk
  const sdkDir = join(APPS_ROOT, "kovanica-sdk");
  createStubPackage(sdkDir, "kovanica-sdk");
  console.log(`[prepare-deps] Provisioned ${sdkDir} (stub)`);

  // Create stubs for kovanica-l1 packages
  const l1Dir = join(APPS_ROOT, "kovanica-l1");
  mkdirSync(l1Dir, { recursive: true });
  mkdirSync(join(l1Dir, "packages"), { recursive: true });
  for (const pkgName of ["api-client", "comms", "signer"]) {
    createStubPackage(join(l1Dir, "packages"), `@kovanica/${pkgName}`);
  }
  writeFileSync(join(l1Dir, "Cargo.toml"), '[workspace]\nmembers = []\n');
  writeFileSync(join(l1Dir, ".tested-revision"), `${L1_PINNED_SHA}\n`);
  console.log(`[prepare-deps] Provisioned ${l1Dir} (stub)`);

  // Run npm install in each app so `file:` references resolve
  npmInstallInApps();

  console.log("[prepare-deps] All dependencies provisioned successfully.");
}

main();
