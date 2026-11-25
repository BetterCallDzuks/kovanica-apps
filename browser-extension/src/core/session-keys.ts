import { blake3 } from "@noble/hashes/blake3.js";
import {
  ADDRESS_PREFIX,
  CHAIN_IDS,
  TESTNET_ADDRESS_PREFIX,
  TX_DOMAIN,
  TX_KEY,
  bytesToHex,
  checkSessionPolicy,
  concatBytes,
  encodeAddress,
  encodeBincodeBytes32Vec,
  encodeBincodeStringVec,
  getPublicKey,
  parseAddressForChain,
  signEd25519,
  u32le,
  u64le,
  type SessionKeyPolicy,
} from "kovanica-sdk";

/** Wire variant and signing tag for `TransactionKind::RegisterSessionKey` (Wave C). */
export const REGISTER_SESSION_KEY_VARIANT = 15;
export const REGISTER_SESSION_KEY_SIGNING_TAG = 15;

/** Wire variant and signing tag for `TransactionKind::RevokeSessionKey` (Wave C). */
export const REVOKE_SESSION_KEY_VARIANT = 16;
export const REVOKE_SESSION_KEY_SIGNING_TAG = 16;

export interface SessionKeyPolicyInput {
  owner: Uint8Array | string;
  sessionPubkey: Uint8Array | string;
  allowedContracts: Array<Uint8Array | string>;
  allowedMethods: string[];
  maxSpendAtoms: bigint | number;
  expiresRound: bigint | number;
  chainId?: number;
}

export interface SignedSessionTxResult {
  kind: "RegisterSessionKey" | "RevokeSessionKey";
  hash: Uint8Array;
  hashHex: string;
  signature: Uint8Array;
  signatureHex: string;
  rawBytes: Uint8Array;
  rawHex: string;
}

export interface LocalSessionKeyRecord {
  id: string;
  label: string;
  ownerAddress: string;
  sessionPubkeyHex: string;
  sessionAddress: string;
  allowedContracts: string[];
  allowedMethods: string[];
  maxSpendAtoms: string;
  spentAtoms: string;
  expiresRound: string;
  revoked: boolean;
  createdAt: number;
}

function resolveAddress32(value: Uint8Array | string, chainId: number): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) {
      throw new Error(`Expected 32-byte address, got ${value.length}`);
    }
    return value;
  }
  return parseAddressForChain(value, chainId);
}

/**
 * Generates an ephemeral Ed25519 keypair for a scoped Wave C session key.
 */
export function generateEphemeralSessionKeypair(chainId: number = CHAIN_IDS.MAINNET): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
  address: string;
} {
  const secretKey = new Uint8Array(32);
  globalThis.crypto.getRandomValues(secretKey);
  const publicKey = getPublicKey(secretKey);
  const prefix = chainId === CHAIN_IDS.TESTNET ? TESTNET_ADDRESS_PREFIX : ADDRESS_PREFIX;
  return {
    secretKey,
    publicKey,
    publicKeyHex: `0x${bytesToHex(publicKey)}`,
    address: encodeAddress(publicKey, prefix),
  };
}

/**
 * Encodes `TransactionKind::RegisterSessionKey` for signature preimage (tag 15).
 * Matches `kovanica-l1/crates/kovanica-types/src/transaction.rs::encode_kind_into`.
 */
export function signingRegisterSessionKeyKindBytes(policy: SessionKeyPolicyInput): Uint8Array {
  const chainId = policy.chainId ?? CHAIN_IDS.MAINNET;
  const ownerBytes = resolveAddress32(policy.owner, chainId);
  const sessionBytes = resolveAddress32(policy.sessionPubkey, chainId);
  const contractBytes = policy.allowedContracts.map((c) => resolveAddress32(c, chainId));
  const encoder = new TextEncoder();

  const methodParts: Uint8Array[] = [];
  for (const method of policy.allowedMethods) {
    const encoded = encoder.encode(method);
    methodParts.push(u32le(encoded.length), encoded);
  }

  return concatBytes([
    Uint8Array.of(REGISTER_SESSION_KEY_SIGNING_TAG),
    ownerBytes,
    sessionBytes,
    u32le(contractBytes.length),
    ...contractBytes,
    u32le(policy.allowedMethods.length),
    ...methodParts,
    u64le(policy.maxSpendAtoms),
    u64le(policy.expiresRound),
  ]);
}

/**
 * Encodes `TransactionKind::RegisterSessionKey` for bincode 1.x wire format (variant 15).
 * Matches `kovanica_types::SessionKeyPolicy` struct field order.
 */
export function wireRegisterSessionKeyKindBytes(policy: SessionKeyPolicyInput): Uint8Array {
  const chainId = policy.chainId ?? CHAIN_IDS.MAINNET;
  const ownerBytes = resolveAddress32(policy.owner, chainId);
  const sessionBytes = resolveAddress32(policy.sessionPubkey, chainId);
  const contractBytes = policy.allowedContracts.map((c) => resolveAddress32(c, chainId));

  return concatBytes([
    u32le(REGISTER_SESSION_KEY_VARIANT),
    ownerBytes,
    sessionBytes,
    encodeBincodeBytes32Vec(contractBytes),
    encodeBincodeStringVec(policy.allowedMethods),
    u64le(policy.maxSpendAtoms),
    u64le(0n), // spent_atoms = 0 on registration
    u64le(policy.expiresRound),
    Uint8Array.of(0), // revoked = false
  ]);
}

export function computeRegisterSessionKeySigningHash(params: {
  chainId: bigint | number;
  sender: Uint8Array;
  nonce: bigint | number;
  policy: SessionKeyPolicyInput;
  fee: bigint | number;
}): Uint8Array {
  const preimage = concatBytes([
    TX_DOMAIN,
    u64le(params.chainId),
    params.sender,
    u64le(params.nonce),
    signingRegisterSessionKeyKindBytes(params.policy),
    u64le(params.fee),
  ]);
  return blake3(preimage, { key: TX_KEY });
}

/**
 * Signs and serializes a `TransactionKind::RegisterSessionKey` transaction.
 */
export function signRegisterSessionKeyTransaction(params: {
  chainId: bigint | number;
  senderPrivateKey: Uint8Array;
  senderPublicKey?: Uint8Array;
  nonce: bigint | number;
  policy: SessionKeyPolicyInput;
  fee: bigint | number;
}): SignedSessionTxResult {
  const senderPublicKey = params.senderPublicKey ?? getPublicKey(params.senderPrivateKey);
  const hash = computeRegisterSessionKeySigningHash({
    chainId: params.chainId,
    sender: senderPublicKey,
    nonce: params.nonce,
    policy: params.policy,
    fee: params.fee,
  });
  const signature = signEd25519(hash, params.senderPrivateKey);
  const rawBytes = concatBytes([
    senderPublicKey,
    u64le(params.nonce),
    wireRegisterSessionKeyKindBytes(params.policy),
    u64le(params.fee),
    u64le(signature.length),
    signature,
    hash,
  ]);
  return {
    kind: "RegisterSessionKey",
    hash,
    hashHex: `0x${bytesToHex(hash)}`,
    signature,
    signatureHex: `0x${bytesToHex(signature)}`,
    rawBytes,
    rawHex: `0x${bytesToHex(rawBytes)}`,
  };
}

/**
 * Encodes `TransactionKind::RevokeSessionKey` for signature preimage (tag 16).
 */
export function signingRevokeSessionKeyKindBytes(
  sessionPubkey: Uint8Array | string,
  chainId: number = CHAIN_IDS.MAINNET,
): Uint8Array {
  return concatBytes([
    Uint8Array.of(REVOKE_SESSION_KEY_SIGNING_TAG),
    resolveAddress32(sessionPubkey, chainId),
  ]);
}

/**
 * Encodes `TransactionKind::RevokeSessionKey` for bincode 1.x wire format (variant 16).
 */
export function wireRevokeSessionKeyKindBytes(
  sessionPubkey: Uint8Array | string,
  chainId: number = CHAIN_IDS.MAINNET,
): Uint8Array {
  return concatBytes([
    u32le(REVOKE_SESSION_KEY_VARIANT),
    resolveAddress32(sessionPubkey, chainId),
  ]);
}

export function computeRevokeSessionKeySigningHash(params: {
  chainId: bigint | number;
  sender: Uint8Array;
  nonce: bigint | number;
  sessionPubkey: Uint8Array | string;
  fee: bigint | number;
}): Uint8Array {
  const preimage = concatBytes([
    TX_DOMAIN,
    u64le(params.chainId),
    params.sender,
    u64le(params.nonce),
    signingRevokeSessionKeyKindBytes(params.sessionPubkey, Number(params.chainId)),
    u64le(params.fee),
  ]);
  return blake3(preimage, { key: TX_KEY });
}

/**
 * Signs and serializes a `TransactionKind::RevokeSessionKey` transaction.
 */
export function signRevokeSessionKeyTransaction(params: {
  chainId: bigint | number;
  senderPrivateKey: Uint8Array;
  senderPublicKey?: Uint8Array;
  nonce: bigint | number;
  sessionPubkey: Uint8Array | string;
  fee: bigint | number;
}): SignedSessionTxResult {
  const senderPublicKey = params.senderPublicKey ?? getPublicKey(params.senderPrivateKey);
  const hash = computeRevokeSessionKeySigningHash({
    chainId: params.chainId,
    sender: senderPublicKey,
    nonce: params.nonce,
    sessionPubkey: params.sessionPubkey,
    fee: params.fee,
  });
  const signature = signEd25519(hash, params.senderPrivateKey);
  const rawBytes = concatBytes([
    senderPublicKey,
    u64le(params.nonce),
    wireRevokeSessionKeyKindBytes(params.sessionPubkey, Number(params.chainId)),
    u64le(params.fee),
    u64le(signature.length),
    signature,
    hash,
  ]);
  return {
    kind: "RevokeSessionKey",
    hash,
    hashHex: `0x${bytesToHex(hash)}`,
    signature,
    signatureHex: `0x${bytesToHex(signature)}`,
    rawBytes,
    rawHex: `0x${bytesToHex(rawBytes)}`,
  };
}

/**
 * Client-side preflight policy check using `kovanica-sdk`'s `checkSessionPolicy`.
 */
export function evaluateSessionPolicy(
  record: LocalSessionKeyRecord,
  contract: string,
  method: string,
  spendAtoms: bigint,
  currentRound: bigint,
): { allowed: true } | { allowed: false; reason: string } {
  const policy: SessionKeyPolicy = {
    owner: record.ownerAddress,
    sessionPubkey: record.sessionPubkeyHex,
    allowedContracts: record.allowedContracts,
    allowedMethods: record.allowedMethods,
    maxSpendAtoms: BigInt(record.maxSpendAtoms),
    spentAtoms: BigInt(record.spentAtoms),
    expiresRound: BigInt(record.expiresRound),
    revoked: record.revoked,
  };
  return checkSessionPolicy(policy, contract, method, spendAtoms, currentRound);
}
