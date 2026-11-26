/**
 * Zero-dependency, MV3 CSP-compliant ISO/IEC 18004 QR Code encoder (Byte mode, ECC Level M,
 * Versions 1-14) emitting deterministic inline SVG markup.
 *
 * Designed for Kovanica PRO-21 addresses (64 chars: kvnc...dag / tknc...dag) and
 * KVP-103 stealth meta-addresses (137 chars: st:kvnc:<scanPubHex>:<spendPubHex>).
 */

interface VersionSpec {
  version: number;
  totalDataCodewords: number;
  ecCodewordsPerBlock: number;
  group1Blocks: number;
  group1DataCodewords: number;
  group2Blocks: number;
  group2DataCodewords: number;
  alignmentCenters: readonly number[];
}

// ISO/IEC 18004 Table 9 (Error Correction Level M) & Annex E (Alignment Patterns), Versions 1..14
const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, totalDataCodewords: 16, ecCodewordsPerBlock: 10, group1Blocks: 1, group1DataCodewords: 16, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [] },
  { version: 2, totalDataCodewords: 28, ecCodewordsPerBlock: 16, group1Blocks: 1, group1DataCodewords: 28, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 18] },
  { version: 3, totalDataCodewords: 44, ecCodewordsPerBlock: 26, group1Blocks: 1, group1DataCodewords: 44, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 22] },
  { version: 4, totalDataCodewords: 64, ecCodewordsPerBlock: 18, group1Blocks: 2, group1DataCodewords: 32, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 26] },
  { version: 5, totalDataCodewords: 86, ecCodewordsPerBlock: 24, group1Blocks: 2, group1DataCodewords: 43, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 30] },
  { version: 6, totalDataCodewords: 108, ecCodewordsPerBlock: 16, group1Blocks: 4, group1DataCodewords: 27, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 34] },
  { version: 7, totalDataCodewords: 124, ecCodewordsPerBlock: 18, group1Blocks: 4, group1DataCodewords: 31, group2Blocks: 0, group2DataCodewords: 0, alignmentCenters: [6, 22, 38] },
  { version: 8, totalDataCodewords: 154, ecCodewordsPerBlock: 22, group1Blocks: 2, group1DataCodewords: 38, group2Blocks: 2, group2DataCodewords: 39, alignmentCenters: [6, 24, 42] },
  { version: 9, totalDataCodewords: 182, ecCodewordsPerBlock: 22, group1Blocks: 3, group1DataCodewords: 36, group2Blocks: 2, group2DataCodewords: 37, alignmentCenters: [6, 26, 46] },
  { version: 10, totalDataCodewords: 216, ecCodewordsPerBlock: 26, group1Blocks: 4, group1DataCodewords: 43, group2Blocks: 1, group2DataCodewords: 44, alignmentCenters: [6, 28, 50] },
  { version: 11, totalDataCodewords: 254, ecCodewordsPerBlock: 30, group1Blocks: 1, group1DataCodewords: 50, group2Blocks: 4, group2DataCodewords: 51, alignmentCenters: [6, 30, 54] },
  { version: 12, totalDataCodewords: 290, ecCodewordsPerBlock: 22, group1Blocks: 6, group1DataCodewords: 36, group2Blocks: 2, group2DataCodewords: 37, alignmentCenters: [6, 32, 58] },
  { version: 13, totalDataCodewords: 334, ecCodewordsPerBlock: 22, group1Blocks: 8, group1DataCodewords: 37, group2Blocks: 1, group2DataCodewords: 38, alignmentCenters: [6, 34, 62] },
  { version: 14, totalDataCodewords: 365, ecCodewordsPerBlock: 24, group1Blocks: 4, group1DataCodewords: 40, group2Blocks: 5, group2DataCodewords: 41, alignmentCenters: [6, 26, 46, 66] },
];

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255]!;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    for (let j = 0; j < ecCount - 1; j++) {
      rem[j] = rem[j + 1]!;
    }
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        rem[j] ^= gfMul(gen[j + 1]!, factor);
      }
    }
  }
  return rem;
}

function selectVersion(byteLength: number): VersionSpec {
  for (const spec of VERSION_SPECS) {
    const countBits = spec.version <= 9 ? 8 : 16;
    const totalBitsNeeded = 4 + countBits + byteLength * 8;
    if (totalBitsNeeded <= spec.totalDataCodewords * 8) {
      return spec;
    }
  }
  throw new Error(`QR payload too long (${byteLength} bytes; max supported is 362 bytes)`);
}

function encodeDataCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  // Byte mode indicator: 0100
  pushBits(0b0100, 4);
  // Character count indicator
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  // Payload bytes
  for (let i = 0; i < bytes.length; i++) {
    pushBits(bytes[i]!, 8);
  }

  const capacityBits = spec.totalDataCodewords * 8;
  // Terminator (up to 4 zero bits)
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(spec.totalDataCodewords);
  const byteCount = bits.length / 8;
  for (let i = 0; i < byteCount; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j]!;
    }
    codewords[i] = b;
  }

  // Pad codewords alternating 0xEC, 0x11
  let padToggle = 0;
  for (let i = byteCount; i < spec.totalDataCodewords; i++) {
    codewords[i] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }
  return codewords;
}

function interleaveBlocks(dataCodewords: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;

  for (let i = 0; i < spec.group1Blocks; i++) {
    const blk = dataCodewords.subarray(offset, offset + spec.group1DataCodewords);
    dataBlocks.push(blk);
    ecBlocks.push(rsComputeEcc(blk, spec.ecCodewordsPerBlock));
    offset += spec.group1DataCodewords;
  }
  for (let i = 0; i < spec.group2Blocks; i++) {
    const blk = dataCodewords.subarray(offset, offset + spec.group2DataCodewords);
    dataBlocks.push(blk);
    ecBlocks.push(rsComputeEcc(blk, spec.ecCodewordsPerBlock));
    offset += spec.group2DataCodewords;
  }

  const maxDataLen = Math.max(spec.group1DataCodewords, spec.group2DataCodewords);
  const totalBlocks = spec.group1Blocks + spec.group2Blocks;
  const out = new Uint8Array(
    spec.totalDataCodewords + totalBlocks * spec.ecCodewordsPerBlock,
  );
  let pos = 0;
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < dataBlocks.length; b++) {
      const blk = dataBlocks[b]!;
      if (i < blk.length) out[pos++] = blk[i]!;
    }
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      out[pos++] = ecBlocks[b]![i]!;
    }
  }
  return out;
}

function computeFormatBits(maskPattern: number): number {
  // ECC Level M = 00
  const data = (0b00 << 3) | (maskPattern & 0b111);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function penaltyScore(grid: Uint8Array, size: number): number {
  let score = 0;
  const at = (r: number, c: number) => grid[r * size + c]!;

  // Rule 1: adjacent modules in row/col in same color
  for (let r = 0; r < size; r++) {
    let runColor = at(r, 0);
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (at(r, c) === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = at(r, c);
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = at(0, c);
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (at(r, c) === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) score += 3 + (runLen - 5);
        runColor = at(r, c);
        runLen = 1;
      }
    }
    if (runLen >= 5) score += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      const m =
        at(r, c) === 1 && at(r, c + 1) === 0 && at(r, c + 2) === 1 && at(r, c + 3) === 1 &&
        at(r, c + 4) === 1 && at(r, c + 5) === 0 && at(r, c + 6) === 1;
      if (m && at(r, c + 7) === 0 && at(r, c + 8) === 0 && at(r, c + 9) === 0 && at(r, c + 10) === 0) {
        score += 40;
      }
      const m2 =
        at(r, c) === 0 && at(r, c + 1) === 0 && at(r, c + 2) === 0 && at(r, c + 3) === 0 &&
        at(r, c + 4) === 1 && at(r, c + 5) === 0 && at(r, c + 6) === 1 && at(r, c + 7) === 1 &&
        at(r, c + 8) === 1 && at(r, c + 9) === 0 && at(r, c + 10) === 1;
      if (m2) score += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      const m =
        at(r, c) === 1 && at(r + 1, c) === 0 && at(r + 2, c) === 1 && at(r + 3, c) === 1 &&
        at(r + 4, c) === 1 && at(r + 5, c) === 0 && at(r + 6, c) === 1;
      if (m && at(r + 7, c) === 0 && at(r + 8, c) === 0 && at(r + 9, c) === 0 && at(r + 10, c) === 0) {
        score += 40;
      }
      const m2 =
        at(r, c) === 0 && at(r + 1, c) === 0 && at(r + 2, c) === 0 && at(r + 3, c) === 0 &&
        at(r + 4, c) === 1 && at(r + 5, c) === 0 && at(r + 6, c) === 1 && at(r + 7, c) === 1 &&
        at(r + 8, c) === 1 && at(r + 9, c) === 0 && at(r + 10, c) === 1;
      if (m2) score += 40;
    }
  }

  // Rule 4: dark module ratio balance
  let dark = 0;
  for (let i = 0; i < grid.length; i++) dark += grid[i]!;
  const total = size * size;
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  score += k * 10;

  return score;
}

export interface QrMatrix {
  version: number;
  size: number;
  modules: Uint8Array; // row-major 0 (light) or 1 (dark)
}

export function encodeQrMatrix(text: string): QrMatrix {
  if (!text) {
    throw new Error("QR payload cannot be empty");
  }
  const bytes = new TextEncoder().encode(text);
  const spec = selectVersion(bytes.length);
  const size = spec.version * 4 + 17;

  const base = new Uint8Array(size * size);
  const isFunction = new Uint8Array(size * size);

  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    base[r * size + c] = dark ? 1 : 0;
    isFunction[r * size + c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        setFunc(r, c, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Alignment patterns
  const centers = spec.alignmentCenters;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = centers[i]!;
      const cc = centers[j]!;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Reserve format info areas + fixed dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i++) {
    setFunc(8, i, false);
  }
  for (let i = size - 7; i < size; i++) {
    setFunc(i, 8, false);
  }
  setFunc(size - 8, 8, true);

  // Version info (versions >= 7)
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  // Place interleaved data + EC codewords
  const dataCodewords = encodeDataCodewords(bytes, spec);
  const allCodewords = interleaveBlocks(dataCodewords, spec);
  let bitIndex = 0;
  const totalBits = allCodewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (isFunction[r * size + c]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (allCodewords[bitIndex >>> 3]! >>> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        base[r * size + c] = bit;
      }
    }
  }

  // Try all 8 masks and pick the lowest penalty score
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestGrid = base;

  const applyFormat = (grid: Uint8Array, mask: number) => {
    const bits = computeFormatBits(mask);
    for (let i = 0; i <= 5; i++) grid[i * size + 8] = (bits >>> i) & 1;
    grid[7 * size + 8] = (bits >>> 6) & 1;
    grid[8 * size + 8] = (bits >>> 7) & 1;
    grid[8 * size + 7] = (bits >>> 8) & 1;
    for (let i = 9; i < 15; i++) grid[8 * size + (14 - i)] = (bits >>> i) & 1;

    for (let i = 0; i < 8; i++) grid[8 * size + (size - 1 - i)] = (bits >>> i) & 1;
    for (let i = 8; i < 15; i++) grid[(size - 15 + i) * size + 8] = (bits >>> i) & 1;
    grid[(size - 8) * size + 8] = 1;
  };

  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.slice();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunction[r * size + c] && maskCondition(mask, r, c)) {
          candidate[r * size + c] ^= 1;
        }
      }
    }
    applyFormat(candidate, mask);
    const score = penaltyScore(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      bestMask = mask;
      bestGrid = candidate;
    }
  }

  // Ensure bestMask is referenced (already applied in bestGrid)
  void bestMask;
  return { version: spec.version, size, modules: bestGrid };
}

export interface QrSvgOptions {
  quietZone?: number;
  darkColor?: string;
  lightColor?: string;
  sizePx?: number;
  ariaLabel?: string;
}

/**
 * Generates a self-contained inline SVG QR code string (zero external requests,
 * 100% MV3 Content Security Policy compliant).
 */
export function renderQrSvg(text: string, options: QrSvgOptions = {}): string {
  const {
    quietZone = 3,
    darkColor = "#09090b",
    lightColor = "#f2f1ee",
    sizePx = 180,
    ariaLabel = "QR Code",
  } = options;

  const { size, modules } = encodeQrMatrix(text);
  const total = size + quietZone * 2;
  const parts: string[] = [];

  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (modules[r * size + c] === 1) {
        const start = c;
        while (c < size && modules[r * size + c] === 1) c++;
        parts.push(`M${start + quietZone},${r + quietZone}h${c - start}v1h-${c - start}z`);
      } else {
        c++;
      }
    }
  }

  const safeLabel = ariaLabel.replace(/["&<>]/g, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${sizePx}" height="${sizePx}" role="img" aria-label="${safeLabel}" ` +
    `shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${lightColor}"/>` +
    `<path d="${parts.join("")}" fill="${darkColor}"/>` +
    `</svg>`
  );
}
