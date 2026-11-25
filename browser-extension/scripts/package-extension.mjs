import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");
const releaseDir = resolve(rootDir, "release");

const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const version = pkg.version || "0.1.0";
const zipName = `kovanica-browser-extension-v${version}.zip`;
const zipPath = resolve(releaseDir, zipName);
const shaPath = `${zipPath}.sha256`;

if (!existsSync(resolve(distDir, "manifest.json"))) {
  throw new Error("dist/manifest.json missing — run `npm run build` first.");
}

mkdirSync(releaseDir, { recursive: true });
rmSync(zipPath, { force: true });

// Package dist/ contents at zip root for Chrome Web Store & Firefox Add-ons submission.
execFileSync("zip", ["-rq", zipPath, "."], { cwd: distDir, stdio: "inherit" });

const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
writeFileSync(shaPath, `${sha256}  ${zipName}\n`, "utf8");
console.log(`Packaged ${zipPath}`);
console.log(`SHA-256: ${sha256}`);
