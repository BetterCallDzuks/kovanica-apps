import { mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

function parseArgs(argv) {
  let target = "chrome";
  let out = "dist";
  for (const arg of argv) {
    if (arg.startsWith("--target=")) {
      target = arg.slice("--target=".length);
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    }
  }
  if (target !== "chrome" && target !== "firefox") {
    throw new Error(`Unsupported build target "${target}". Expected "chrome" or "firefox".`);
  }
  return { target, outDir: resolve(rootDir, out) };
}

async function build() {
  const { target, outDir } = parseArgs(process.argv.slice(2));
  const iconsDir = resolve(outDir, "icons");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(iconsDir, { recursive: true });

  const common = {
    bundle: true,
    minify: true,
    sourcemap: false,
    target: target === "firefox" ? ["firefox128"] : ["chrome120"],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  };

  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/background/index.ts")],
      outfile: resolve(outDir, "background.js"),
      format: "esm",
      platform: "browser",
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/content/index.ts")],
      outfile: resolve(outDir, "content.js"),
      format: "iife",
      platform: "browser",
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/inpage/index.ts")],
      outfile: resolve(outDir, "inpage.js"),
      format: "iife",
      platform: "browser",
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/popup/main.tsx")],
      outfile: resolve(outDir, "popup.js"),
      format: "esm",
      platform: "browser",
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/approval/main.tsx")],
      outfile: resolve(outDir, "approval.js"),
      format: "esm",
      platform: "browser",
    }),
  ]);

  const manifestSrc =
    target === "firefox"
      ? resolve(rootDir, "public/manifest.firefox.json")
      : resolve(rootDir, "public/manifest.json");

  if (!existsSync(manifestSrc)) {
    throw new Error(`Missing manifest file: ${manifestSrc}`);
  }

  copyFileSync(manifestSrc, resolve(outDir, "manifest.json"));
  copyFileSync(resolve(rootDir, "popup.html"), resolve(outDir, "popup.html"));
  copyFileSync(resolve(rootDir, "approval.html"), resolve(outDir, "approval.html"));
  copyFileSync(resolve(rootDir, "src/styles.css"), resolve(outDir, "styles.css"));

  for (const size of [16, 32, 48, 128]) {
    const iconSrc = resolve(rootDir, `public/icons/icon-${size}.png`);
    if (!existsSync(iconSrc)) {
      throw new Error(`Missing icon asset: ${iconSrc}. Run scripts/generate-store-assets.py first.`);
    }
    copyFileSync(iconSrc, resolve(iconsDir, `icon-${size}.png`));
  }

  for (const coinSize of [128, 256]) {
    const coinSrc = resolve(rootDir, `public/icons/kvnc-coin-${coinSize}.png`);
    if (existsSync(coinSrc)) {
      copyFileSync(coinSrc, resolve(iconsDir, `kvnc-coin-${coinSize}.png`));
    }
  }

  console.log(`Built Kovanica MV3 browser extension (${target}) into ${outDir}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
