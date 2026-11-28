#!/usr/bin/env node
/**
 * prepare-deps.mjs — Materialize pinned external dependencies for kovanica-apps.
 *
 * kovanica-apps consumes `kovanica-sdk` and `kovanica-l1` packages via `file:`
 * references, which only work in a monorepo checkout. This script clones the
 * exact pinned SHAs, builds them, and places them under node_modules/ so a
 * standalone `git clone` + `npm ci` works without a sibling checkout.
 *
 * Modeled on kovanica-playground/scripts/prepare-sdk.mjs.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APPS_ROOT = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(join(APPS_ROOT, "package.json"), "utf8"));

// Pinned revisions — update these when rolling to a new SDK / L1 release.
const SDK_PINNED_SHA = pkg?.kovanicaSdk?.testedRevision;
const L1_PINNED_SHA = pkg?.kovanicaL1?.testedRevision;

const SDK_REPO_URL = pkg?.kovanicaSdk?.repository || "https://github.com/BetterCallDzuks/kovanica-sdk";
const L1_REPO_URL = pkg?.kovanicaL1?.repository || "https://github.com/BetterCallDzuks/kovanica-l1";

const SIBLING_SDK_DIR = resolve(APPS_ROOT, "../kovanica-sdk");
const SIBLING_L1_DIR = resolve(APPS_ROOT, "../kovanica-l1");
const INSTALLED_SDK_DIR = join(APPS_ROOT, "node_modules", "kovanica-sdk");
const INSTALLED_L1_DIR = join(APPS_ROOT, "node_modules", "kovanica-l1");

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

/** Clone a repo at a pinned SHA into a target dir, building if it has a build script. */
function provision(repoUrl, pinnedSha, targetDir, siblingDir, installDir) {
  // 1. If sibling exists and is at (or includes) the pinned SHA, use it via symlink.
  if (existsSync(siblingDir)) {
    let siblingHead = "";
    let siblingClean = false;
    try {
      siblingHead = execSync(`git -C "${siblingDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
      const statusOut = execSync(`git -C "${siblingDir}" status --porcelain`, { encoding: "utf8" }).trim();
      siblingClean = statusOut.length === 0;
    } catch {}

    let siblingIncludesPinned = siblingHead === pinnedSha;
    if (!siblingIncludesPinned && siblingHead) {
      try {
        execSync(`git -C "${siblingDir}" merge-base --is-ancestor ${pinnedSha} HEAD`, { stdio: "ignore" });
        siblingIncludesPinned = true;
      } catch {
        siblingIncludesPinned = false;
      }
    }

    if (siblingIncludesPinned) {
      const distExists = existsSync(join(targetDir, "dist", "index.js")) ||
        existsSync(join(targetDir, "dist", "index.mjs")) ||
        existsSync(join(targetDir, "src")); // TS-only packages may not have dist/
      if (!distExists) {
        console.log(`[prepare-deps] Building sibling at ${siblingHead}...`);
        execSync("npm install", { cwd: siblingDir, stdio: "inherit", env: cleanEnv });
        execSync("npm run build", { cwd: siblingDir, stdio: "inherit", env: cleanEnv });
      }
      if (!(existsSync(installDir) && lstatSync(installDir).isSymbolicLink())) {
        if (existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });
        symlinkSync(siblingDir, installDir, "dir");
      }
      console.log(`[prepare-deps] Verified ${targetDir} at pinned SHA ${pinnedSha}`);
      return;
    }
  }

  // 2. Otherwise, materialize the exact pinned SHA in an isolated cache.
  console.log(`[prepare-deps] Materializing ${targetDir} at pinned SHA ${pinnedSha}...`);
  const buildCacheDir = join(tmpdir(), `kovanica-deps-${targetDir.replace(/\//g, "-")}-${pinnedSha}`);

  if (!existsSync(join(buildCacheDir, "package.json"))) {
    rmSync(buildCacheDir, { recursive: true, force: true });
    mkdirSync(buildCacheDir, { recursive: true });
    const siblingGit = join(siblingDir, ".git");
    const refArg = existsSync(siblingGit) ? `--reference-if-able "${siblingGit}" ` : "";
    execSync(`git clone --no-checkout ${refArg}"${repoUrl}" "${buildCacheDir}"`, { stdio: "inherit" });
    execSync(`git -C "${buildCacheDir}" checkout --detach ${pinnedSha}`, { stdio: "inherit" });
  }

  const verifiedHead = execSync(`git -C "${buildCacheDir}" rev-parse HEAD`, { encoding: "utf8" }).trim();
  if (verifiedHead !== pinnedSha) {
    fail(`SHA verification failed for ${targetDir}: expected ${pinnedSha}, got ${verifiedHead}`);
  }

  execSync("npm install", { cwd: buildCacheDir, stdio: "inherit", env: cleanEnv });
  execSync("npm run build", { cwd: buildCacheDir, stdio: "inherit", env: cleanEnv });

  if (existsSync(installDir) && lstatSync(installDir).isSymbolicLink()) unlinkSync(installDir);
  else if (existsSync(installDir)) rmSync(installDir, { recursive: true, force: true });

  mkdirSync(installDir, { recursive: true });
  cpSync(join(buildCacheDir, "package.json"), join(installDir, "package.json"), { overwrite: true });
  // Copy dist/ if present, otherwise copy src/ for TS-only packages
  if (existsSync(join(buildCacheDir, "dist"))) {
    cpSync(join(buildCacheDir, "dist"), join(installDir, "dist"), { recursive: true });
  } else if (existsSync(join(buildCacheDir, "src"))) {
    cpSync(join(buildCacheDir, "src"), join(installDir, "src"), { recursive: true });
  }
  if (existsSync(join(buildCacheDir, "README.md"))) {
    cpSync(join(buildCacheDir, "README.md"), join(installDir, "README.md"), { overwrite: true });
  }
  writeFileSync(join(installDir, ".tested-revision"), `${pinnedSha}\n`, "utf8");
  console.log(`[prepare-deps] Materialized ${targetDir} (${pinnedSha}) into node_modules/`);
}

function main() {
  mkdirSync(join(APPS_ROOT, "node_modules"), { recursive: true });

  provision(SDK_REPO_URL, SDK_PINNED_SHA, "kovanica-sdk", SIBLING_SDK_DIR, INSTALLED_SDK_DIR);
  provision(L1_REPO_URL, L1_PINNED_SHA, "kovanica-l1", SIBLING_L1_DIR, INSTALLED_L1_DIR);

  console.log("[prepare-deps] All dependencies materialized successfully.");
}

main();
