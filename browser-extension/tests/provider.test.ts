import { describe, expect, it } from "vitest";
import {
  CHAIN_IDS,
  bytesToHex,
  decodeSignedTransferTransaction,
  encodeAddress,
  getPublicKey,
  verifyTransferTransactionSignature,
} from "kovanica-sdk";
import {
  KovanicaProviderController,
  type PendingApprovalRequest,
  type ProviderEventName,
} from "../src/core/provider-protocol";
import { buildApprovalPreview, verifyPersonalMessage } from "../src/core/tx-signer";
import { MemoryStorageAdapter, VaultManager } from "../src/core/vault";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT_PUBKEY = new Uint8Array(32).fill(0x77);
const RECIPIENT_PRO21 = encodeAddress(RECIPIENT_PUBKEY);

describe("window.kovanica Provider Bridge & Approval Flow", () => {
  it("handles connect, accounts/chain events, Wave A-C signing, and explicit approval/rejection", async () => {
    const storage = new MemoryStorageAdapter();
    const vault = new VaultManager(storage);
    await vault.createVault({
      password: "ProviderTestPassword!2026",
      mnemonic: TEST_MNEMONIC,
    });

    const events: Array<{ event: ProviderEventName; payload: unknown }> = [];
    const approvals: PendingApprovalRequest[] = [];

    const controller = new KovanicaProviderController({
      vault,
      initialChainId: CHAIN_IDS.MAINNET,
      onBroadcast: (event, payload) => events.push({ event, payload }),
      onApprovalPrompt: (req) => {
        approvals.push(req);
      },
    });

    const origin = "https://dex.kovanica.online";

    // Before connect, getAccounts is empty and signing is blocked
    expect(await controller.handleRequest(origin, "getChainId")).toBe(CHAIN_IDS.MAINNET);
    expect(await controller.handleRequest(origin, "getAccounts")).toEqual([]);
    await expect(
      controller.handleRequest(origin, "signMessage", { message: "hello" }),
    ).rejects.toThrow(/not connected/);

    // Connect flow with explicit approval
    const connectPromise = controller.handleRequest(origin, "connect");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.preview.method).toBe("connect");
    await controller.resolveApproval(approvals[0]!.id, true);

    const connected = (await connectPromise) as { accounts: string[]; chainId: number };
    expect(connected.accounts).toHaveLength(1);
    expect(connected.accounts[0]!.startsWith("kvnc")).toBe(true);
    expect(connected.chainId).toBe(CHAIN_IDS.MAINNET);
    expect(events.some((e) => e.event === "accountsChanged")).toBe(true);

    // signMessage with approval + signature verification
    const msgPromise = controller.handleRequest(origin, "signMessage", {
      message: "Sign in to Kovanica DEX",
    });
    const msgReq = approvals.at(-1)!;
    expect(msgReq.preview.title).toBe("Sign Message");
    await controller.resolveApproval(msgReq.id, true);
    const signedMsg = (await msgPromise) as { messageHashHex: string; signatureHex: string };
    const activePub = await vault.withActiveKeypair(({ publicKey }) => new Uint8Array(publicKey));
    expect(verifyPersonalMessage("Sign in to Kovanica DEX", signedMsg.signatureHex, activePub)).toBe(
      true,
    );

    // signTransaction (Transfer) with approval preview showing Wave B fee & PRO-21 check
    const txPromise = controller.handleRequest(origin, "signTransaction", {
      kind: "transfer",
      to: RECIPIENT_PRO21,
      amount: "1000000000",
      nonce: 1,
    });
    const txReq = approvals.at(-1)!;
    expect(txReq.preview.recipientCheck?.valid).toBe(true);
    expect(BigInt(txReq.preview.feeEstimate!.totalFeeAtoms)).toBeGreaterThan(0n);
    await controller.resolveApproval(txReq.id, true);
    const signedTx = (await txPromise) as { rawTxHex: string };
    const decoded = decodeSignedTransferTransaction(signedTx.rawTxHex, {
      chainId: CHAIN_IDS.MAINNET,
    });
    expect(verifyTransferTransactionSignature(decoded)).toBe(true);
    expect(decoded.recipientAddress).toBe(RECIPIENT_PRO21);

    // signBatchTransaction (Wave A)
    const batchPromise = controller.handleRequest(origin, "signBatchTransaction", {
      nonce: 2,
      actions: [
        { kind: "transfer", to: RECIPIENT_PRO21, amount: "500000" },
        {
          kind: "call",
          contract: RECIPIENT_PRO21,
          method: "mint",
          argsHex: "0x010203",
          gasLimit: 250_000,
        },
      ],
    });
    const batchReq = approvals.at(-1)!;
    expect(batchReq.preview.title).toContain("Atomic Batch");
    await controller.resolveApproval(batchReq.id, true);
    const signedBatch = (await batchPromise) as { rawTxHex: string; actionCount: number };
    expect(signedBatch.actionCount).toBe(2);
    expect(signedBatch.rawTxHex.startsWith("0x")).toBe(true);

    // signSponsoredTransaction (Wave A)
    const sponsorPriv = new Uint8Array(32).fill(0x99);
    const sponsorPub = getPublicKey(sponsorPriv);
    const sponsorPromise = controller.handleRequest(origin, "signSponsoredTransaction", {
      nonce: 3,
      feePayerPublicKeyHex: `0x${bytesToHex(sponsorPub)}`,
      feePayerPrivateKeyHex: `0x${bytesToHex(sponsorPriv)}`,
      inner: {
        kind: "transfer",
        to: RECIPIENT_PRO21,
        amount: "250000",
        nonce: 3,
      },
    });
    const sponsorReq = approvals.at(-1)!;
    expect(sponsorReq.preview.title).toContain("Sponsored");
    await controller.resolveApproval(sponsorReq.id, true);
    const signedSponsor = (await sponsorPromise) as {
      rawTxHex: string;
      senderSignatureHex: string;
      sponsorSignatureHex: string;
    };
    expect(signedSponsor.senderSignatureHex.startsWith("0x")).toBe(true);
    expect(signedSponsor.sponsorSignatureHex.startsWith("0x")).toBe(true);

    // Rejection flow
    const rejectedPromise = controller.handleRequest(origin, "signMessage", {
      message: "Reject me",
    });
    await controller.resolveApproval(approvals.at(-1)!.id, false, "User clicked Reject");
    await expect(rejectedPromise).rejects.toThrow(/User clicked Reject/);

    // switchChain emits chainChanged
    await controller.handleRequest(origin, "switchChain", { chainId: CHAIN_IDS.TESTNET });
    expect(controller.getChainId()).toBe(CHAIN_IDS.TESTNET);
    expect(events.some((e) => e.event === "chainChanged" && e.payload === CHAIN_IDS.TESTNET)).toBe(
      true,
    );
  });

  it("flags invalid legacy hex recipients and computes Wave B storage deposit in approval preview", () => {
    const preview = buildApprovalPreview({
      method: "signTransaction",
      chainId: CHAIN_IDS.MAINNET,
      requestParams: {
        kind: "call",
        contract: "0x" + "ab".repeat(32),
        method: "store_data",
        argsHex: "0xdeadbeef",
        nonce: 7,
        storageDeltaBytes: 128,
      },
      baseFeeInfo: {
        baseFeePerByte: 25n,
        defaultGasPriceAtoms: 2n,
        storageDepositPerByte: 100_000n,
      },
    });

    expect(preview.recipientCheck?.valid).toBe(false);
    expect(preview.feeEstimate?.baseFeePerByte).toBe("25");
    expect(preview.feeEstimate?.storageDepositDeltaAtoms).toBe("12800000");
  });
});
