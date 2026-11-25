import { mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const distDir = resolve(rootDir, "dist");
const iconsDir = resolve(distDir, "icons");

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

function generateKovanicaPng(size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (1 + size * 4));
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const outerR = size * 0.46;
  const innerR = size * 0.24;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= innerR) {
        // Bright Kovanica cyan-blue core
        raw[px] = 59;
        raw[px + 1] = 130;
        raw[px + 2] = 246;
        raw[px + 3] = 255;
      } else if (dist <= outerR) {
        // Dark slate ring
        raw[px] = 19;
        raw[px + 1] = 25;
        raw[px + 2] = 36;
        raw[px + 3] = 255;
      } else {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
      }
    }
  }

  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function build() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(iconsDir, { recursive: true });

  const common = {
    bundle: true,
    minify: true,
    sourcemap: false,
    target: ["chrome120", "firefox128"],
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  };

  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/background/index.ts")],
      outfile: resolve(distDir, "background.js"),
      format: "esm",
      platform: "browser",
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/content/index.ts")],
      outfile: resolve(distDir, "content.js"),
      format: "iife",
      platform: "browser",
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/inpage/index.ts")],
      outfile: resolve(distDir, "inpage.js"),
      format: "iife",
      platform: "browser",
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/popup/main.tsx")],
      outfile: resolve(distDir, "popup.js"),
      format: "esm",
      platform: "browser",
    }),
    esbuild.build({
      ...common,
      entryPoints: [resolve(rootDir, "src/approval/main.tsx")],
      outfile: resolve(distDir, "approval.js"),
      format: "esm",
      platform: "browser",
    }),
  ]);

  copyFileSync(resolve(rootDir, "public/manifest.json"), resolve(distDir, "manifest.json"));
  copyFileSync(resolve(rootDir, "popup.html"), resolve(distDir, "popup.html"));
  copyFileSync(resolve(rootDir, "approval.html"), resolve(distDir, "approval.html"));
  copyFileSync(resolve(rootDir, "src/styles.css"), resolve(distDir, "styles.css"));

  for (const size of [16, 32, 48, 128]) {
    writeFileSync(resolve(iconsDir, `icon-${size}.png`), generateKovanicaPng(size));
  }

  console.log("Built Kovanica MV3 browser extension into", distDir);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
