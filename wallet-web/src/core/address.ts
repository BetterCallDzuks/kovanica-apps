import {
  decodeAddress as sdkDecodeAddress,
  encodeAddress as sdkEncodeAddress,
  isValidAddress as sdkIsValidAddress,
  parseAddressForChain,
  isLegacyAddressAllowed,
  ADDRESS_LEN,
  CHAIN_IDS,
  ADDRESS_PREFIX,
  TESTNET_ADDRESS_PREFIX,
} from "kovanica-sdk";

export const ADDRESS_LENGTH = ADDRESS_LEN;

export { ADDRESS_PREFIX, TESTNET_ADDRESS_PREFIX };
export const encodeAddress = sdkEncodeAddress;
export const decodeAddress = sdkDecodeAddress;
export const isValidAddress = sdkIsValidAddress;

/**
 * Returns network-aware address:
 * - On Testnet (Chain ID 2): encodes to `tknc...dag`
 * - On Mainnet (Chain ID 1) and other chains: encodes to `kvnc...dag`
 */
export function formatAddressForChain(
  addressOrPubkey: string | Uint8Array,
  chainId: number | null,
): string {
  let pubkey: Uint8Array;
  if (typeof addressOrPubkey === "string") {
    try {
      pubkey = sdkDecodeAddress(addressOrPubkey.trim());
    } catch {
      return addressOrPubkey;
    }
  } else {
    pubkey = addressOrPubkey;
  }
  const prefix = chainId === CHAIN_IDS.TESTNET ? TESTNET_ADDRESS_PREFIX : ADDRESS_PREFIX;
  return sdkEncodeAddress(pubkey, prefix);
}

export type AddressCheck = {
  ok: boolean;
  legacyHex: boolean;
  message: string;
};

function isLegacyHex(value: string): boolean {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return true;
  if (/^kvnc[0-9a-f]{64}dag$/.test(trimmed)) return true;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return true;
  return false;
}

export function checkAddress(value: string, chainId: number | null): AddressCheck {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, legacyHex: false, message: "Enter a recipient address" };
  if (isLegacyHex(trimmed)) {
    const allowed = chainId != null && isLegacyAddressAllowed(chainId);
    if (!allowed) {
      return {
        ok: false,
        legacyHex: true,
        message:
          chainId === CHAIN_IDS.MAINNET
            ? "Mainnet rejects legacy hex addresses. Use a kvnc…dag address."
            : "This network rejects legacy hex addresses. Use a kvnc…dag address.",
      };
    }
    return { ok: true, legacyHex: true, message: "Legacy hex accepted on this network" };
  }
  try {
    if (chainId != null) {
      parseAddressForChain(trimmed, chainId);
    } else {
      sdkDecodeAddress(trimmed);
    }
    return { ok: true, legacyHex: false, message: "Checksum matches" };
  } catch (error) {
    return {
      ok: false,
      legacyHex: false,
      message: error instanceof Error ? error.message : "Invalid address",
    };
  }
}

export function decodeRecipient(value: string, chainId: number | null): Uint8Array {
  const check = checkAddress(value, chainId);
  if (!check.ok) throw new Error(check.message);
  if (chainId != null) {
    return parseAddressForChain(value, chainId);
  }
  return sdkDecodeAddress(value.trim());
}
