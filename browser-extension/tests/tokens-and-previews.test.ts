import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAIN_IDS,
  buildRwaFreezeCall,
  buildRwaMintCall,
  buildRwaTransferCall,
  buildTokenTransferCall,
  bytesToHex,
  concatBytes,
  encodeAddress,
  encodeBincodeString,
  u64le,
  u128le,
} from "kovanica-sdk";
import { decodeContractCallPreview } from "../src/core/contract-preview";
import {
  TokenWatchlistManager,
  formatTokenUnits,
  getKvp102StateSlotHex,
  readKvp102TokenBalance,
} from "../src/core/tokens";
import { buildApprovalPreview } from "../src/core/tx-signer";
import { MemoryStorageAdapter } from "../src/core/vault";

const HOLDER_BYTES = new Uint8Array(32).fill(0x21);
const HOLDER_MAINNET = encodeAddress(HOLDER_BYTES);
const HOLDER_TESTNET = `tknc${HOLDER_MAINNET.slice(4)}`;

const CONTRACT_BYTES = new Uint8Array(32).fill(0x55);
const CONTRACT_MAINNET = encodeAddress(CONTRACT_BYTES);
const CONTRACT_TESTNET = `tknc${CONTRACT_MAINNET.slice(4)}`;

const SPENDER_BYTES = new Uint8Array(32).fill(0x88);
const SPENDER_MAINNET = encodeAddress(SPENDER_BYTES);

const POOL_ID = new Uint8Array(32).fill(0xaa);
const NATIVE_KVNC_TOKEN = new Uint8Array(32);

function encodeAmmSwapExactInArgs(
  poolId: Uint8Array,
  tokenIn: Uint8Array,
  amountIn: bigint,
  minOut: bigint,
): Uint8Array {
  return concatBytes([poolId, tokenIn, u128le(amountIn), u128le(minOut)]);
}

function encodeAmmAddLiquidityArgs(
  poolId: Uint8Array,
  amount0Desired: bigint,
  amount1Desired: bigint,
  minLpOut: bigint,
): Uint8Array {
  return concatBytes([poolId, u128le(amount0Desired), u128le(amount1Desired), u128le(minLpOut)]);
}

function encodeAmmRemoveLiquidityArgs(
  poolId: Uint8Array,
  lpAmount: bigint,
  minAmount0: bigint,
  minAmount1: bigint,
): Uint8Array {
  return concatBytes([poolId, u128le(lpAmount), u128le(minAmount0), u128le(minAmount1)]);
}

function encodeAmmCreatePoolArgs(tokenA: Uint8Array, tokenB: Uint8Array): Uint8Array {
  return concatBytes([tokenA, tokenB]);
}

function encodeRwaAllowlistArgs(account: Uint8Array, allowed: boolean, kycTier: number): Uint8Array {
  return concatBytes([account, Uint8Array.of(allowed ? 1 : 0, kycTier)]);
}

function encodeRwaPauseArgs(paused: boolean): Uint8Array {
  return Uint8Array.of(paused ? 1 : 0);
}

function encodeRwaForcedTransferArgs(
  from: Uint8Array,
  to: Uint8Array,
  amount: bigint,
  reason: string,
): Uint8Array {
  return concatBytes([from, to, u128le(amount), encodeBincodeString(reason)]);
}

function encodeTokenApproveArgs(spender: Uint8Array, amount: bigint): Uint8Array {
  return concatBytes([spender, u128le(amount)]);
}

function encodeKvp102State(params: {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  balances: Array<{ account: Uint8Array; amount: bigint }>;
  paused?: boolean;
  icon?: string;
}): string {
  const owner = new Uint8Array(32).fill(0x11);
  const minter = new Uint8Array(32).fill(0x12);
  const balanceEntries = params.balances.map((b) => concatBytes([b.account, u128le(b.amount)]));
  const payload = concatBytes([
    encodeBincodeString(params.name),
    encodeBincodeString(params.symbol),
    Uint8Array.of(params.decimals),
    u128le(params.totalSupply),
    owner,
    minter,
    u64le(BigInt(params.balances.length)),
    ...balanceEntries,
    u64le(0n), // allowances
    Uint8Array.of(params.paused ? 1 : 0),
    encodeBincodeString(params.icon ?? ""),
  ]);
  return `0x${bytesToHex(payload)}`;
}

describe("KVNC Coin Branding Assets", () => {
  it("ships optimized 128x128 and 256x256 KVNC coin PNGs in public/icons", () => {
    for (const size of [128, 256]) {
      const p = resolve(__dirname, "..", "public", "icons", `kvnc-coin-${size}.png`);
      expect(existsSync(p)).toBe(true);
      const buf = readFileSync(p);
      // PNG magic header: 89 50 4E 47
      expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      // Keep assets lightweight (< 150 KB)
      expect(buf.length).toBeLessThan(150_000);
    }
  });
});

describe("KVP-102 Token Watchlist & Balance Reader", () => {
  it("formats token base units losslessly with BigInt", () => {
    expect(formatTokenUnits(0n, 9)).toBe("0");
    expect(formatTokenUnits(1_500_000n, 6)).toBe("1.5");
    expect(formatTokenUnits(123_456_789_000n, 9)).toBe("123.456789");
    expect(formatTokenUnits(42n, 0)).toBe("42");
  });

  it("persists, deduplicates, isolates by chainId, and validates strict PRO-21 addresses", async () => {
    const storage = new MemoryStorageAdapter();
    const watchlist = new TokenWatchlistManager(storage);

    await expect(watchlist.add(CHAIN_IDS.MAINNET, "0x" + "ab".repeat(32))).rejects.toThrow();
    await expect(watchlist.add(CHAIN_IDS.MAINNET, CONTRACT_TESTNET)).rejects.toThrow();

    const added = await watchlist.add(CHAIN_IDS.MAINNET, CONTRACT_MAINNET);
    expect(added.contract).toBe(CONTRACT_MAINNET);
    await watchlist.add(CHAIN_IDS.MAINNET, CONTRACT_MAINNET); // dedupe

    expect(await watchlist.list(CHAIN_IDS.MAINNET)).toHaveLength(1);
    expect(await watchlist.list(CHAIN_IDS.TESTNET)).toHaveLength(0);

    await watchlist.add(CHAIN_IDS.TESTNET, CONTRACT_TESTNET);
    expect(await watchlist.list(CHAIN_IDS.TESTNET)).toHaveLength(1);

    expect(await watchlist.remove(CHAIN_IDS.MAINNET, CONTRACT_MAINNET)).toBe(true);
    expect(await watchlist.list(CHAIN_IDS.MAINNET)).toHaveLength(0);
    expect(await watchlist.list(CHAIN_IDS.TESTNET)).toHaveLength(1);
  });

  it("decodes KVP-102 token storage state and handles empty/corrupt/error responses", async () => {
    const rawHex = encodeKvp102State({
      name: "Kovanica USD",
      symbol: "KUSD",
      decimals: 6,
      totalSupply: 1_000_000_000_000n,
      balances: [{ account: HOLDER_BYTES, amount: 250_750_000n }],
      paused: false,
      icon: "https://kovanica.online/kusd.png",
    });

    const ok = await readKvp102TokenBalance({
      client: {
        getStorageAt: async (_addr, slot) => {
          expect(slot).toBe(getKvp102StateSlotHex());
          return rawHex;
        },
      },
      contractAddress: CONTRACT_MAINNET,
      holderAddress: HOLDER_MAINNET,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(ok.status).toBe("ok");
    expect(ok.symbol).toBe("KUSD");
    expect(ok.name).toBe("Kovanica USD");
    expect(ok.balanceFormatted).toBe("250.75");
    expect(ok.paused).toBe(false);

    const empty = await readKvp102TokenBalance({
      client: { getStorageAt: async () => "0x" },
      contractAddress: CONTRACT_MAINNET,
      holderAddress: HOLDER_MAINNET,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(empty.status).toBe("not_a_token");

    const corrupt = await readKvp102TokenBalance({
      client: { getStorageAt: async () => "0xdeadbeef" },
      contractAddress: CONTRACT_MAINNET,
      holderAddress: HOLDER_MAINNET,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(corrupt.status).toBe("unreadable");

    const failed = await readKvp102TokenBalance({
      client: {
        getStorageAt: async () => {
          throw new Error("RPC timeout");
        },
      },
      contractAddress: CONTRACT_MAINNET,
      holderAddress: HOLDER_MAINNET,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(failed.status).toBe("error");
    expect(failed.error).toContain("RPC timeout");
  });
});

describe("AMM, RWA (KVP-106), and KVP-102 Contract-Call Signing Previews", () => {
  it("decodes AMM swap, liquidity, pool creation, and warns when minOut is 0", () => {
    const swapArgs = encodeAmmSwapExactInArgs(
      POOL_ID,
      NATIVE_KVNC_TOKEN,
      5_000_000_000n, // 5 KVNC
      0n,
    );
    const swapPreview = buildApprovalPreview({
      method: "signTransaction",
      chainId: CHAIN_IDS.MAINNET,
      requestParams: {
        kind: "call",
        contract: CONTRACT_MAINNET,
        method: "amm_swap_exact_in",
        argsHex: `0x${bytesToHex(swapArgs)}`,
        value: "5000000000",
        nonce: 4,
      },
    });
    expect(swapPreview.category).toBe("amm");
    expect(swapPreview.badgeLabel).toBe("AMM / DEX");
    expect(swapPreview.title).toBe("Sign AMM Swap");
    expect(swapPreview.warning).toMatch(/minOut = 0/i);
    expect(swapPreview.details.some((d) => d.label === "Token In" && d.value === "KVNC (Native)")).toBe(
      true,
    );

    const addLiqArgs = encodeAmmAddLiquidityArgs(POOL_ID, 1000n, 2000n, 500n);
    const addLiq = decodeContractCallPreview({
      method: "amm_add_liquidity",
      argsHex: `0x${bytesToHex(addLiqArgs)}`,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(addLiq.title).toBe("Sign Add Liquidity");
    expect(addLiq.details.find((d) => d.label === "Min LP Out")?.value).toBe("500 LP");

    const remLiqArgs = encodeAmmRemoveLiquidityArgs(POOL_ID, 250n, 100n, 200n);
    const remLiq = decodeContractCallPreview({
      method: "amm_remove_liquidity",
      argsHex: `0x${bytesToHex(remLiqArgs)}`,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(remLiq.title).toBe("Sign Remove Liquidity");
    expect(remLiq.details.find((d) => d.label === "LP Burn Amount")?.value).toBe("250 LP");

    const createPoolArgs = encodeAmmCreatePoolArgs(NATIVE_KVNC_TOKEN, CONTRACT_BYTES);
    const createPool = decodeContractCallPreview({
      method: "amm_create_pool",
      argsHex: `0x${bytesToHex(createPoolArgs)}`,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(createPool.title).toBe("Sign Create AMM Pool");
    expect(createPool.details.find((d) => d.label === "Token A")?.value).toBe("KVNC (Native)");
    expect(createPool.details.find((d) => d.label === "Token B")?.value).toBe(CONTRACT_MAINNET);
  });

  it("decodes Institutional RWA (KVP-106) calls and flags high-impact compliance controls", () => {
    const mintArgs = buildRwaMintCall(HOLDER_BYTES, 10_000n);
    const mintPreview = buildApprovalPreview({
      method: "signTransaction",
      chainId: CHAIN_IDS.MAINNET,
      requestParams: {
        kind: "call",
        contract: CONTRACT_MAINNET,
        method: "rwa_mint",
        argsHex: `0x${bytesToHex(mintArgs)}`,
        nonce: 1,
      },
    });
    expect(mintPreview.category).toBe("rwa");
    expect(mintPreview.badgeLabel).toBe("RWA (KVP-106)");
    expect(mintPreview.title).toBe("Sign RWA Mint");
    expect(mintPreview.details.find((d) => d.label === "Mint To")?.value).toBe(HOLDER_MAINNET);

    const transferArgs = buildRwaTransferCall(HOLDER_BYTES, 500n);
    const transfer = decodeContractCallPreview({
      method: "rwa_transfer",
      argsHex: `0x${bytesToHex(transferArgs)}`,
      chainId: CHAIN_IDS.TESTNET,
    });
    expect(transfer.details.find((d) => d.label === "Recipient")?.value).toBe(HOLDER_TESTNET);

    const allowlistArgs = encodeRwaAllowlistArgs(HOLDER_BYTES, true, 2);
    const allowlist = decodeContractCallPreview({
      method: "rwa_set_allowlist",
      argsHex: `0x${bytesToHex(allowlistArgs)}`,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(allowlist.details.find((d) => d.label === "KYC Tier")?.value).toBe("Tier 2");

    const freezeArgs = buildRwaFreezeCall(HOLDER_BYTES, true);
    const freeze = decodeContractCallPreview({
      method: "rwa_freeze",
      argsHex: `0x${bytesToHex(freezeArgs)}`,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(freeze.warning).toMatch(/Compliance Action/i);

    const pauseArgs = encodeRwaPauseArgs(true);
    const pause = decodeContractCallPreview({
      method: "rwa_set_paused",
      argsHex: `0x${bytesToHex(pauseArgs)}`,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(pause.warning).toMatch(/Pausing halts/i);

    const clawbackArgs = encodeRwaForcedTransferArgs(
      HOLDER_BYTES,
      SPENDER_BYTES,
      750n,
      "Court order #2026-04",
    );
    const clawback = decodeContractCallPreview({
      method: "rwa_forced_transfer",
      argsHex: `0x${bytesToHex(clawbackArgs)}`,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(clawback.title).toContain("Clawback");
    expect(clawback.warning).toMatch(/without holder consent/i);
    expect(clawback.details.find((d) => d.label === "Audit Reason")?.value).toBe(
      "Court order #2026-04",
    );
  });

  it("decodes KVP-102 token transfer/approve and Wave A atomic approve+swap batches", () => {
    const transferCall = buildTokenTransferCall(CONTRACT_BYTES, HOLDER_BYTES, 999n);
    const tokTransfer = decodeContractCallPreview({
      method: "token_transfer",
      argsHex: `0x${bytesToHex(transferCall.args)}`,
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(tokTransfer.category).toBe("token");
    expect(tokTransfer.details.find((d) => d.label === "Recipient")?.value).toBe(HOLDER_MAINNET);

    const approveArgs = encodeTokenApproveArgs(SPENDER_BYTES, 1_000_000n);
    const swapArgs = encodeAmmSwapExactInArgs(
      POOL_ID,
      CONTRACT_BYTES,
      1_000_000n,
      950_000n,
    );
    const batchPreview = buildApprovalPreview({
      method: "signBatchTransaction",
      chainId: CHAIN_IDS.MAINNET,
      requestParams: {
        nonce: 9,
        actions: [
          {
            kind: "call",
            contract: CONTRACT_MAINNET,
            method: "token_approve",
            argsHex: `0x${bytesToHex(approveArgs)}`,
          },
          {
            kind: "call",
            contract: SPENDER_MAINNET,
            method: "amm_swap_exact_in",
            argsHex: `0x${bytesToHex(swapArgs)}`,
          },
        ],
      },
    });
    expect(batchPreview.category).toBe("amm");
    expect(batchPreview.badgeLabel).toBe("Batch · AMM / DEX");
    expect(batchPreview.details.some((d) => d.label.includes("token_approve"))).toBe(true);
    expect(batchPreview.details.some((d) => d.label.includes("amm_swap_exact_in"))).toBe(true);
  });
});
