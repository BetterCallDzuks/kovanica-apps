import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");
const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const version = pkg.version || "0.1.0";

// Fixed UTC timestamp for byte-for-byte reproducible ZIP archives (2026-01-01T00:00:00Z).
const REPRODUCIBLE_EPOCH = new Date("2026-01-01T00:00:00Z");

function parseTarget(argv) {
  let target = "all";
  for (const arg of argv) {
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    }
  }
  const allowed = new Set(["chrome", "firefox", "firefox-source", "all"]);
  if (!allowed.has(target)) {
    throw new Error(`Unsupported target "${target}". Use chrome | firefox | firefox-source | all.`);
  }
  return target;
}

function listFilesSorted(baseDir, currentDir = baseDir, out = []) {
  const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = resolve(currentDir, entry.name);
    if (entry.isDirectory()) {
      listFilesSorted(baseDir, full, out);
    } else if (entry.isFile()) {
      out.push(relative(baseDir, full).replaceAll("\\", "/"));
    }
  }
  return out;
}

function normalizeMtimes(baseDir, relFiles) {
  for (const rel of relFiles) {
    utimesSync(resolve(baseDir, rel), REPRODUCIBLE_EPOCH, REPRODUCIBLE_EPOCH);
  }
}

function validateBuiltManifest(buildDir, target) {
  const manifestPath = resolve(buildDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing built manifest at ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.manifest_version !== 3) {
    throw new Error(`Expected manifest_version 3, got ${manifest.manifest_version}`);
  }
  if (!manifest.description || manifest.description.length > 132) {
    throw new Error(
      `manifest.description must be <= 132 chars for Chrome Web Store (got ${manifest.description?.length ?? 0})`,
    );
  }
  for (const size of ["16", "32", "48", "128"]) {
    const iconRel = manifest.icons?.[size];
    if (!iconRel || !existsSync(resolve(buildDir, iconRel))) {
      throw new Error(`Missing icon ${size}px referenced by manifest: ${iconRel}`);
    }
  }

  if (target === "chrome") {
    if (!manifest.background?.service_worker) {
      throw new Error("Chrome MV3 manifest must define background.service_worker");
    }
    if (!manifest.minimum_chrome_version) {
      throw new Error("Chrome MV3 manifest must define minimum_chrome_version");
    }
  } else if (target === "firefox") {
    if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
      throw new Error("Firefox MV3 manifest must define background.scripts");
    }
    if (!manifest.browser_specific_settings?.gecko?.id) {
      throw new Error("Firefox MV3 manifest must define browser_specific_settings.gecko.id");
    }
  }
}

function createReproducibleZip(cwd, relFiles, zipPath) {
  mkdirSync(dirname(zipPath), { recursive: true });
  rmSync(zipPath, { force: true });
  normalizeMtimes(cwd, relFiles);

  // -X strips OS-specific extra attributes; sorted file list ensures deterministic order.
  execFileSync("zip", ["-qX", zipPath, ...relFiles], {
    cwd,
    env: { ...process.env, TZ: "UTC" },
    stdio: "inherit",
  });

  const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  const zipName = zipPath.split("/").pop();
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`, "utf8");
  const sizeBytes = statSync(zipPath).size;
  console.log(`Packaged ${zipPath} (${sizeBytes} bytes)`);
  console.log(`  SHA-256: ${sha256}`);
  return { zipPath, sha256, sizeBytes };
}

function buildAndPackageBrowser(target) {
  const buildDir = resolve(distDir, target);
  execFileSync(
    process.execPath,
    [resolve(__dirname, "build-extension.mjs"), `--target=${target}`, `--out=dist/${target}`],
    { cwd: rootDir, stdio: "inherit" },
  );
  validateBuiltManifest(buildDir, target);

  const relFiles = listFilesSorted(buildDir);
  const zipPath = resolve(distDir, `kovanica-wallet-${target}-v${version}.zip`);
  return createReproducibleZip(buildDir, relFiles, zipPath);
}

function packageFirefoxSource() {
  const zipPath = resolve(distDir, `kovanica-wallet-firefox-source-v${version}.zip`);
  const excludeTop = new Set(["node_modules", "dist", "release", ".git"]);

  function collectSourceFiles(currentDir = rootDir, out = []) {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (currentDir === rootDir && excludeTop.has(entry.name)) {
        continue;
      }
      if (entry.name === ".DS_Store" || entry.name.endsWith(".tsbuildinfo")) {
        continue;
      }
      const full = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        collectSourceFiles(full, out);
      } else if (entry.isFile()) {
        out.push(relative(rootDir, full).replaceAll("\\", "/"));
      }
    }
    return out;
  }

  const relFiles = collectSourceFiles();
  mkdirSync(dirname(zipPath), { recursive: true });
  rmSync(zipPath, { force: true });

  // Do not mutate source file mtimes in git working tree; still strip extra attrs and sort deterministically.
  execFileSync("zip", ["-qX", zipPath, ...relFiles], {
    cwd: rootDir,
    env: { ...process.env, TZ: "UTC" },
    stdio: "inherit",
  });

  const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  const zipName = zipPath.split("/").pop();
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`, "utf8");
  const sizeBytes = statSync(zipPath).size;
  console.log(`Packaged AMO source archive ${zipPath} (${sizeBytes} bytes, ${relFiles.length} files)`);
  console.log(`  SHA-256: ${sha256}`);
  return { zipPath, sha256, sizeBytes };
}

function main() {
  const target = parseTarget(process.argv.slice(2));
  if (target === "chrome" || target === "all") {
    buildAndPackageBrowser("chrome");
  }
  if (target === "firefox" || target === "all") {
    buildAndPackageBrowser("firefox");
  }
  if (target === "firefox-source" || target === "all") {
    packageFirefoxSource();
  }
}

main();
