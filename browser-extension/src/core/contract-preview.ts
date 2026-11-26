import {
  BincodeReader,
  CHAIN_IDS,
  bytesToHex,
  encodeAddress,
  formatKvnc,
  hexToBytes,
} from "kovanica-sdk";

export type ContractPreviewCategory = "amm" | "rwa" | "token" | "contract";

export interface DecodedContractCallPreview {
  category: ContractPreviewCategory;
  badgeLabel: string;
  title: string;
  summary: string;
  warning?: string;
  details: Array<{ label: string; value: string }>;
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function isAllZeroBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function formatAddrForChain(pubkey: Uint8Array, chainId: number): string {
  if (isAllZeroBytes(pubkey)) {
    return "KVNC (Native)";
  }
  const encoded = encodeAddress(pubkey);
  if (chainId === CHAIN_IDS.TESTNET && encoded.startsWith("kvnc")) {
    return `tknc${encoded.slice(4)}`;
  }
  return encoded;
}

function safeArgsBytes(argsHex?: string): Uint8Array | null {
  if (!argsHex) return new Uint8Array(0);
  const clean = strip0x(argsHex.trim());
  if (!clean) return new Uint8Array(0);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  return hexToBytes(clean);
}

function shortHex(bytes: Uint8Array): string {
  const full = bytesToHex(bytes);
  return `0x${full.slice(0, 12)}...${full.slice(-8)}`;
}

/**
 * Classifies and decodes AMM / DEX (`kovanica-amm`), Institutional RWA (`KVP-106`),
 * and KVP-102 token contract calls into structured human-readable approval previews.
 * Falls back gracefully when calldata is custom or truncated.
 */
export function decodeContractCallPreview(params: {
  method: string;
  argsHex?: string;
  chainId: number;
  valueAtoms?: bigint;
}): DecodedContractCallPreview {
  const method = (params.method ?? "").trim();
  const lower = method.toLowerCase();
  const args = safeArgsBytes(params.argsHex);
  const valueAtoms = params.valueAtoms ?? 0n;

  // --- AMM / DEX (`kovanica-amm`) -----------------------------------------
  if (lower === "amm_swap_exact_in" || lower === "swap_exact_in" || lower === "swap") {
    const details: Array<{ label: string; value: string }> = [];
    let summary = "Swap tokens through the Kovanica AMM liquidity pool.";
    if (args && args.length >= 96) {
      try {
        const r = new BincodeReader(args);
        const poolId = r.readFixedBytes(32, "poolId");
        const tokenIn = r.readFixedBytes(32, "tokenIn");
        const amountIn = r.readU128("amountIn");
        const minOut = r.readU128("minOut");
        const tokenLabel = formatAddrForChain(tokenIn, params.chainId);
        const isNative = isAllZeroBytes(tokenIn);
        details.push(
          { label: "Pool ID", value: shortHex(poolId) },
          { label: "Token In", value: tokenLabel },
          {
            label: "Amount In",
            value: isNative ? `${formatKvnc(amountIn)} KVNC` : `${amountIn.toString()} units`,
          },
          { label: "Min Out (Slippage Guard)", value: `${minOut.toString()} units` },
        );
        summary = isNative
          ? `AMM Swap: ${formatKvnc(amountIn)} KVNC (min out ${minOut.toString()} units)`
          : `AMM Swap: ${amountIn.toString()} units (min out ${minOut.toString()} units)`;
      } catch {
        // Fall back to generic AMM preview below
      }
    }
    return {
      category: "amm",
      badgeLabel: "AMM / DEX",
      title: "Sign AMM Swap",
      summary,
      warning:
        details.length > 0 &&
        details.find((d) => d.label === "Min Out (Slippage Guard)")?.value === "0 units"
          ? "Slippage protection is set to 0 (minOut = 0). This swap is vulnerable to price impact."
          : undefined,
      details,
    };
  }

  if (lower === "amm_add_liquidity" || lower === "add_liquidity") {
    const details: Array<{ label: string; value: string }> = [];
    if (args && args.length >= 80) {
      try {
        const r = new BincodeReader(args);
        const poolId = r.readFixedBytes(32, "poolId");
        const amount0 = r.readU128("amount0Desired");
        const amount1 = r.readU128("amount1Desired");
        const minLpOut = r.readU128("minLpOut");
        details.push(
          { label: "Pool ID", value: shortHex(poolId) },
          { label: "Token 0 Desired", value: `${amount0.toString()} units` },
          { label: "Token 1 Desired", value: `${amount1.toString()} units` },
          { label: "Min LP Out", value: `${minLpOut.toString()} LP` },
        );
      } catch {
        // Fallback
      }
    }
    return {
      category: "amm",
      badgeLabel: "AMM / DEX",
      title: "Sign Add Liquidity",
      summary: "Deposit token pair into a Kovanica AMM liquidity pool.",
      details,
    };
  }

  if (lower === "amm_remove_liquidity" || lower === "remove_liquidity") {
    const details: Array<{ label: string; value: string }> = [];
    if (args && args.length >= 80) {
      try {
        const r = new BincodeReader(args);
        const poolId = r.readFixedBytes(32, "poolId");
        const lpAmount = r.readU128("lpAmount");
        const min0 = r.readU128("minAmount0");
        const min1 = r.readU128("minAmount1");
        details.push(
          { label: "Pool ID", value: shortHex(poolId) },
          { label: "LP Burn Amount", value: `${lpAmount.toString()} LP` },
          { label: "Min Token 0 Out", value: `${min0.toString()} units` },
          { label: "Min Token 1 Out", value: `${min1.toString()} units` },
        );
      } catch {
        // Fallback
      }
    }
    return {
      category: "amm",
      badgeLabel: "AMM / DEX",
      title: "Sign Remove Liquidity",
      summary: "Burn LP shares and withdraw underlying reserves from an AMM pool.",
      details,
    };
  }

  if (lower === "amm_create_pool" || lower === "create_pool") {
    const details: Array<{ label: string; value: string }> = [];
    if (args && args.length >= 64) {
      try {
        const r = new BincodeReader(args);
        const tokenA = r.readFixedBytes(32, "tokenA");
        const tokenB = r.readFixedBytes(32, "tokenB");
        details.push(
          { label: "Token A", value: formatAddrForChain(tokenA, params.chainId) },
          { label: "Token B", value: formatAddrForChain(tokenB, params.chainId) },
        );
      } catch {
        // Fallback
      }
    }
    return {
      category: "amm",
      badgeLabel: "AMM / DEX",
      title: "Sign Create AMM Pool",
      summary: "Initialize a new constant-product liquidity pool on Kovanica AMM.",
      details,
    };
  }

  // --- Institutional RWA (`KVP-106`) --------------------------------------
  if (lower === "rwa_mint" || lower === "rwa_transfer") {
    const isMint = lower === "rwa_mint";
    const details: Array<{ label: string; value: string }> = [];
    let summary = isMint
      ? "Mint regulated KVP-106 RWA asset units to an allowlisted holder."
      : "Transfer regulated KVP-106 RWA asset units.";
    if (args && args.length >= 48) {
      try {
        const r = new BincodeReader(args);
        const to = r.readFixedBytes(32, "to");
        const amount = r.readU128("amount");
        const addr = formatAddrForChain(to, params.chainId);
        details.push(
          { label: isMint ? "Mint To" : "Recipient", value: addr },
          { label: "RWA Amount", value: `${amount.toString()} units` },
        );
        summary = `${isMint ? "Mint" : "Transfer"} ${amount.toString()} RWA units to ${addr.slice(0, 14)}...`;
      } catch {
        // Fallback
      }
    }
    return {
      category: "rwa",
      badgeLabel: "RWA (KVP-106)",
      title: isMint ? "Sign RWA Mint" : "Sign RWA Transfer",
      summary,
      details,
    };
  }

  if (lower === "rwa_burn") {
    const details: Array<{ label: string; value: string }> = [];
    if (args && args.length >= 16) {
      try {
        const r = new BincodeReader(args);
        const amount = r.readU128("amount");
        details.push({ label: "Burn Amount", value: `${amount.toString()} units` });
      } catch {
        // Fallback
      }
    }
    return {
      category: "rwa",
      badgeLabel: "RWA (KVP-106)",
      title: "Sign RWA Burn / Redemption",
      summary: "Permanently burn KVP-106 RWA units from your balance.",
      details,
    };
  }

  if (lower === "rwa_freeze") {
    const details: Array<{ label: string; value: string }> = [];
    let frozenState: boolean | null = null;
    if (args && args.length >= 33) {
      try {
        const r = new BincodeReader(args);
        const account = r.readFixedBytes(32, "account");
        frozenState = r.readBool("frozen");
        details.push(
          { label: "Target Holder", value: formatAddrForChain(account, params.chainId) },
          { label: "Action", value: frozenState ? "FREEZE account" : "UNFREEZE account" },
        );
      } catch {
        // Fallback
      }
    }
    return {
      category: "rwa",
      badgeLabel: "RWA (KVP-106)",
      title: frozenState === false ? "Sign RWA Unfreeze" : "Sign RWA Account Freeze",
      summary: "Compliance control: toggle transfer freeze status on a KVP-106 holder.",
      warning:
        frozenState !== false
          ? "Compliance Action: Freezing an account blocks all RWA transfers for that holder."
          : undefined,
      details,
    };
  }

  if (lower === "rwa_set_allowlist") {
    const details: Array<{ label: string; value: string }> = [];
    if (args && args.length >= 34) {
      try {
        const r = new BincodeReader(args);
        const account = r.readFixedBytes(32, "account");
        const allowed = r.readBool("allowed");
        const kycTier = r.readU8("kycTier");
        details.push(
          { label: "Holder", value: formatAddrForChain(account, params.chainId) },
          { label: "Allowlist Status", value: allowed ? "Approved (Allowlisted)" : "Revoked" },
          { label: "KYC Tier", value: `Tier ${kycTier}` },
        );
      } catch {
        // Fallback
      }
    }
    return {
      category: "rwa",
      badgeLabel: "RWA (KVP-106)",
      title: "Sign RWA KYC Allowlist Update",
      summary: "Update KYC allowlist authorization for a KVP-106 RWA holder.",
      details,
    };
  }

  if (lower === "rwa_set_paused") {
    const details: Array<{ label: string; value: string }> = [];
    let paused: boolean | null = null;
    if (args && args.length >= 1) {
      try {
        const r = new BincodeReader(args);
        paused = r.readBool("paused");
        details.push({ label: "Contract State", value: paused ? "PAUSED" : "ACTIVE (Unpaused)" });
      } catch {
        // Fallback
      }
    }
    return {
      category: "rwa",
      badgeLabel: "RWA (KVP-106)",
      title: paused === false ? "Sign RWA Unpause" : "Sign RWA Emergency Pause",
      summary: "Compliance control: pause or resume all transfers on this KVP-106 RWA contract.",
      warning:
        paused !== false
          ? "High-Impact Compliance Action: Pausing halts all token transfers globally."
          : undefined,
      details,
    };
  }

  if (lower === "rwa_forced_transfer") {
    const details: Array<{ label: string; value: string }> = [];
    if (args && args.length >= 88) {
      try {
        const r = new BincodeReader(args);
        const from = r.readFixedBytes(32, "from");
        const to = r.readFixedBytes(32, "to");
        const amount = r.readU128("amount");
        const reason = r.readString(256, "reason");
        details.push(
          { label: "Clawback From", value: formatAddrForChain(from, params.chainId) },
          { label: "Transfer To", value: formatAddrForChain(to, params.chainId) },
          { label: "RWA Amount", value: `${amount.toString()} units` },
          { label: "Audit Reason", value: reason },
        );
      } catch {
        // Fallback
      }
    }
    return {
      category: "rwa",
      badgeLabel: "RWA (KVP-106)",
      title: "Sign RWA Forced Transfer (Clawback)",
      summary: "Regulated issuer clawback / court-ordered transfer on a KVP-106 asset.",
      warning:
        "High-Impact Compliance Action: Forced transfer moves RWA units without holder consent.",
      details,
    };
  }

  if (lower === "rwa_create" || lower === "rwa_update_metadata" || lower.startsWith("rwa_")) {
    return {
      category: "rwa",
      badgeLabel: "RWA (KVP-106)",
      title: `Sign RWA Call (${method})`,
      summary: `Invoke institutional RWA method ${method}.`,
      details: valueAtoms > 0n ? [{ label: "Attached Value", value: `${formatKvnc(valueAtoms)} KVNC` }] : [],
    };
  }

  // --- KVP-102 Token (`kovanica-token`) -----------------------------------
  if (lower === "token_transfer" || lower === "token_approve" || lower === "token_mint") {
    const isApprove = lower === "token_approve";
    const isMint = lower === "token_mint";
    const details: Array<{ label: string; value: string }> = [];
    let summary = isApprove
      ? "Grant a spender allowance on a KVP-102 token contract."
      : isMint
        ? "Mint KVP-102 token units to an account."
        : "Transfer KVP-102 token units.";
    if (args && args.length >= 48) {
      try {
        const r = new BincodeReader(args);
        const target = r.readFixedBytes(32, "target");
        const amount = r.readU128("amount");
        const addr = formatAddrForChain(target, params.chainId);
        details.push(
          { label: isApprove ? "Spender" : isMint ? "Mint To" : "Recipient", value: addr },
          { label: isApprove ? "Allowance" : "Token Amount", value: `${amount.toString()} units` },
        );
        summary = isApprove
          ? `Approve ${addr.slice(0, 14)}... to spend ${amount.toString()} token units`
          : `${isMint ? "Mint" : "Transfer"} ${amount.toString()} token units to ${addr.slice(0, 14)}...`;
      } catch {
        // Fallback
      }
    }
    return {
      category: "token",
      badgeLabel: "KVP-102 Token",
      title: isApprove
        ? "Sign Token Approval"
        : isMint
          ? "Sign Token Mint"
          : "Sign KVP-102 Transfer",
      summary,
      warning: isApprove
        ? "Verify the spender address and allowance cap before approving."
        : undefined,
      details,
    };
  }

  // --- Generic Contract Call ----------------------------------------------
  return {
    category: "contract",
    badgeLabel: "Smart Contract",
    title: "Sign Contract Call",
    summary: `Invoke ${method} on contract`,
    details: [],
  };
}
