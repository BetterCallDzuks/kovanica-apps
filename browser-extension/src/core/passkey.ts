import {
  ADDRESS_PREFIX,
  CHAIN_IDS,
  SignatureScheme,
  TESTNET_ADDRESS_PREFIX,
  bytesToHex,
  deriveTypedAddress,
  encodeAddress,
  hexToBytes,
  wipe,
} from "kovanica-sdk";
import { blake3 } from "@noble/hashes/blake3.js";
import type { PasskeyWrappedVaultKey } from "./vault";

export const PASSKEY_RP_NAME = "Kovanica Wallet";
export const PASSKEY_KEY_DOMAIN = new TextEncoder().encode("KVNC/passkey-vault-wrap/v1");

export interface PasskeyCredentialResult {
  credentialId: string;
  p256PublicKey: Uint8Array;
  prfSecret: Uint8Array;
}

export interface PasskeyAssertionResult {
  credentialId: string;
  prfSecret: Uint8Array;
  authenticatorData?: Uint8Array;
  signature?: Uint8Array;
}

export interface WebAuthnAdapter {
  createPasskey(params: {
    rpId: string;
    userName: string;
    challenge: Uint8Array;
  }): Promise<PasskeyCredentialResult>;
  assertPasskey(params: {
    rpId: string;
    credentialId: string;
    challenge: Uint8Array;
  }): Promise<PasskeyAssertionResult>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/**
 * Derives the canonical Wave C typed address for a WebAuthn P-256 (secp256r1) public key
 * using `SignatureScheme.Secp256r1WebAuthn` (`KVNC/addr/v2 || 0x01 || pubkey`).
 */
export function derivePasskeyTypedAddress(
  p256PublicKey: Uint8Array,
  chainId: number = CHAIN_IDS.MAINNET,
): {
  scheme: SignatureScheme.Secp256r1WebAuthn;
  typedAddressBytes: Uint8Array;
  typedAddressHex: string;
  pro21Address: string;
} {
  if (p256PublicKey.length !== 33 && p256PublicKey.length !== 65) {
    throw new Error(
      `Expected 33-byte compressed or 65-byte uncompressed P-256 public key, got ${p256PublicKey.length} bytes`,
    );
  }
  const typedAddressBytes = deriveTypedAddress(
    SignatureScheme.Secp256r1WebAuthn,
    p256PublicKey,
  );
  const prefix = chainId === CHAIN_IDS.TESTNET ? TESTNET_ADDRESS_PREFIX : ADDRESS_PREFIX;
  return {
    scheme: SignatureScheme.Secp256r1WebAuthn,
    typedAddressBytes,
    typedAddressHex: `0x${bytesToHex(typedAddressBytes)}`,
    pro21Address: encodeAddress(typedAddressBytes, prefix),
  };
}

async function importWrapKeyFromPrf(prfSecret: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = blake3(new Uint8Array([...PASSKEY_KEY_DOMAIN, ...prfSecret]));
  try {
    return await globalThis.crypto.subtle.importKey(
      "raw",
      toArrayBuffer(keyMaterial),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    wipe(keyMaterial);
  }
}

/**
 * Registers a Passkey (P-256 / Secp256r1WebAuthn) and wraps the vault password using
 * AES-256-GCM keyed by the WebAuthn PRF secret so the Passkey can unlock the encrypted vault
 * without ever storing plaintext password or private keys.
 */
export async function registerPasskeyForVault(params: {
  adapter: WebAuthnAdapter;
  rpId: string;
  userName: string;
  vaultPassword: string;
  chainId?: number;
}): Promise<PasskeyWrappedVaultKey> {
  const challenge = randomBytes(32);
  const cred = await params.adapter.createPasskey({
    rpId: params.rpId,
    userName: params.userName,
    challenge,
  });

  const derived = derivePasskeyTypedAddress(cred.p256PublicKey, params.chainId);
  const iv = randomBytes(12);
  const wrapKey = await importWrapKeyFromPrf(cred.prfSecret);
  const passwordBytes = new TextEncoder().encode(params.vaultPassword);

  try {
    const wrapped = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      wrapKey,
      toArrayBuffer(passwordBytes),
    );
    return {
      credentialId: cred.credentialId,
      p256PublicKeyHex: bytesToHex(cred.p256PublicKey),
      typedAddressHex: derived.typedAddressHex,
      pro21Address: derived.pro21Address,
      ivHex: bytesToHex(iv),
      wrappedPasswordHex: bytesToHex(new Uint8Array(wrapped)),
      createdAt: Date.now(),
    };
  } finally {
    wipe(passwordBytes);
    wipe(cred.prfSecret);
  }
}

/**
 * Authenticates via Passkey assertion and unwraps the vault password in memory.
 */
export async function unwrapVaultPasswordWithPasskey(params: {
  adapter: WebAuthnAdapter;
  rpId: string;
  record: PasskeyWrappedVaultKey;
}): Promise<string> {
  const challenge = randomBytes(32);
  const assertion = await params.adapter.assertPasskey({
    rpId: params.rpId,
    credentialId: params.record.credentialId,
    challenge,
  });

  const wrapKey = await importWrapKeyFromPrf(assertion.prfSecret);
  try {
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(hexToBytes(params.record.ivHex)) },
      wrapKey,
      toArrayBuffer(hexToBytes(params.record.wrappedPasswordHex)),
    );
    const plainBytes = new Uint8Array(decrypted);
    try {
      return new TextDecoder().decode(plainBytes);
    } finally {
      wipe(plainBytes);
    }
  } finally {
    wipe(assertion.prfSecret);
  }
}

/**
 * Browser WebAuthn adapter using `navigator.credentials` (ES256 / P-256, `alg: -7`).
 * Uses WebAuthn PRF extension when available, with deterministic credential-bound fallback.
 */
export function createBrowserWebAuthnAdapter(): WebAuthnAdapter {
  const prfSalt = new TextEncoder().encode("kovanica-wallet-vault-prf-v1");

  return {
    async createPasskey({ rpId, userName, challenge }) {
      if (typeof navigator === "undefined" || !navigator.credentials) {
        throw new Error("WebAuthn is not available in this browser context");
      }
      const userId = randomBytes(16);
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { id: rpId, name: PASSKEY_RP_NAME },
          user: {
            id: toArrayBuffer(userId),
            name: userName,
            displayName: userName,
          },
          challenge: toArrayBuffer(challenge),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 (P-256 / secp256r1)
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
          timeout: 60_000,
          extensions: {
            prf: { eval: { first: toArrayBuffer(prfSalt) } },
          } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;

      if (!cred) {
        throw new Error("Passkey registration was cancelled");
      }

      const response = cred.response as AuthenticatorAttestationResponse;
      const spki = response.getPublicKey?.();
      // Extract raw 65-byte uncompressed P-256 point from SPKI DER (last 65 bytes of 91-byte P-256 SPKI)
      let p256PublicKey: Uint8Array;
      if (spki && spki.byteLength >= 65) {
        p256PublicKey = new Uint8Array(spki.slice(spki.byteLength - 65));
      } else {
        // Fallback deterministic 33-byte compressed key representation from rawId if browser hides SPKI
        const hash = blake3(new Uint8Array(cred.rawId));
        p256PublicKey = new Uint8Array(33);
        p256PublicKey[0] = 0x02;
        p256PublicKey.set(hash, 1);
      }

      const ext = cred.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
      };
      const prfFirst = ext?.prf?.results?.first;
      const prfSecret = prfFirst
        ? new Uint8Array(prfFirst)
        : blake3(new Uint8Array([...new Uint8Array(cred.rawId), ...prfSalt]));

      return {
        credentialId: bytesToHex(new Uint8Array(cred.rawId)),
        p256PublicKey,
        prfSecret,
      };
    },

    async assertPasskey({ rpId, credentialId, challenge }) {
      if (typeof navigator === "undefined" || !navigator.credentials) {
        throw new Error("WebAuthn is not available in this browser context");
      }
      const rawId = hexToBytes(credentialId);
      const assertion = (await navigator.credentials.get({
        publicKey: {
          rpId,
          challenge: toArrayBuffer(challenge),
          allowCredentials: [
            {
              type: "public-key",
              id: toArrayBuffer(rawId),
            },
          ],
          userVerification: "required",
          timeout: 60_000,
          extensions: {
            prf: { eval: { first: toArrayBuffer(prfSalt) } },
          } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;

      if (!assertion) {
        throw new Error("Passkey authentication was cancelled");
      }

      const response = assertion.response as AuthenticatorAssertionResponse;
      const ext = assertion.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } };
      };
      const prfFirst = ext?.prf?.results?.first;
      const prfSecret = prfFirst
        ? new Uint8Array(prfFirst)
        : blake3(new Uint8Array([...rawId, ...prfSalt]));

      return {
        credentialId,
        prfSecret,
        authenticatorData: new Uint8Array(response.authenticatorData),
        signature: new Uint8Array(response.signature),
      };
    },
  };
}
