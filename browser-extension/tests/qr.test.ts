import { describe, expect, it } from "vitest";
import {
  deriveStealthKeypairFromMnemonic,
  encodeAddress,
  formatStealthMetaAddress,
} from "kovanica-sdk";
import { encodeQrMatrix, renderQrSvg } from "../src/core/qr";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const MAINNET_PRO21 = encodeAddress(new Uint8Array(32).fill(0x42));
const TESTNET_PRO21 = `tknc${MAINNET_PRO21.slice(4)}`;

const STEALTH_KP = deriveStealthKeypairFromMnemonic(TEST_MNEMONIC);
const STEALTH_META = formatStealthMetaAddress(
  STEALTH_KP.scanPubkeyHex,
  STEALTH_KP.spendPubkeyHex,
);

function assertFinderPatterns(size: number, modules: Uint8Array): void {
  const at = (r: number, c: number) => modules[r * size + c];
  const checkCorner = (top: number, left: number) => {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        const expected = dist === 2 ? 0 : 1;
        expect(at(top + dr, left + dc)).toBe(expected);
      }
    }
  };
  checkCorner(0, 0);
  checkCorner(0, size - 7);
  checkCorner(size - 7, 0);
}

describe("Inline SVG QR Code encoder (PRO-21 & KVP-103)", () => {
  it("generates a valid deterministic inline SVG QR for PRO-21 kvnc...dag and tknc...dag addresses", () => {
    for (const addr of [MAINNET_PRO21, TESTNET_PRO21]) {
      expect(addr.length).toBe(64);
      const matrix = encodeQrMatrix(addr);
      expect(matrix.version).toBeGreaterThanOrEqual(4);
      expect(matrix.size).toBe(matrix.version * 4 + 17);
      expect(matrix.modules.length).toBe(matrix.size * matrix.size);
      assertFinderPatterns(matrix.size, matrix.modules);

      const svg = renderQrSvg(addr, { ariaLabel: "PRO-21 Address QR" });
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain(`viewBox="0 0 ${matrix.size + 6} ${matrix.size + 6}"`);
      expect(svg).toContain('aria-label="PRO-21 Address QR"');
      expect(svg).toContain('<path d="M');
      expect(svg).not.toContain("<image");
      expect(svg).not.toContain("href=");
      expect(svg).not.toContain("https://");

      // Deterministic output
      expect(renderQrSvg(addr, { ariaLabel: "PRO-21 Address QR" })).toBe(svg);
    }
  });

  it("generates a valid inline SVG QR for KVP-103 st:kvnc:... stealth meta-addresses", () => {
    expect(STEALTH_META.startsWith("st:kvnc:")).toBe(true);
    expect(STEALTH_META.length).toBe(137);

    const matrix = encodeQrMatrix(STEALTH_META);
    expect(matrix.version).toBeGreaterThanOrEqual(8);
    expect(matrix.size).toBe(matrix.version * 4 + 17);
    assertFinderPatterns(matrix.size, matrix.modules);

    const svg = renderQrSvg(STEALTH_META, { ariaLabel: "KVP-103 Stealth QR" });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${matrix.size + 6} ${matrix.size + 6}"`);
    expect(svg).toContain('aria-label="KVP-103 Stealth QR"');
    expect(svg).toContain('<path d="M');
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("href=");
    expect(svg).not.toContain("https://");
  });

  it("rejects empty payloads", () => {
    expect(() => encodeQrMatrix("")).toThrow(/empty/i);
    expect(() => renderQrSvg("")).toThrow(/empty/i);
  });
});
