package online.kovanica.node

import uniffi.kovanica_light.LightFfiException
import uniffi.kovanica_light.createHdWallet
import uniffi.kovanica_light.defaultMobileNodeConfig
import uniffi.kovanica_light.importHdWallet
import uniffi.kovanica_light.revealMnemonicRaw
import uniffi.kovanica_light.signTransferHd
import uniffi.kovanica_light.syncMobileNodePeer
import uniffi.kovanica_light.verifyPowHeaderJson

/**
 * UniFFI calls into `libkovanica_light_ffi.so` from L1 at the pinned commit.
 * The mnemonic returned by wallet creation is dropped here. The screen reveals
 * it only through [reveal].
 */
class LightFfiBridge : NativeBridge.Bridge {
    override fun createHd(passphrase: String): NativeBridge.Created {
        val created = createHdWallet(24u, passphrase)
        return NativeBridge.Created(created.address, created.keystoreJson)
    }

    override fun importHd(mnemonic: String, passphrase: String): NativeBridge.Created {
        val imported = importHdWallet(mnemonic, passphrase)
        return NativeBridge.Created(imported.address, imported.keystoreJson)
    }

    override fun reveal(keystoreJson: String, passphrase: String): String =
        revealMnemonicRaw(keystoreJson, passphrase)

    override fun signTransfer(
        keystoreJson: String,
        passphrase: String,
        chainId: Long,
        toAddress: String,
        amount: Long,
        fee: Long,
        nonce: Long,
    ): String = signTransferHd(
        keystoreJson,
        passphrase,
        "",
        0u,
        toAddress,
        amount.toULong(),
        fee.toULong(),
        nonce.toULong(),
        chainId.toULong(),
    )

    override fun verifyHeader(chainId: Long, headerJson: String, parentJson: String): String {
        return try {
            val verified = verifyPowHeaderJson(chainId.toULong(), headerJson, parentJson, null)
            "accepted round ${verified.round}"
        } catch (error: LightFfiException.Failed) {
            error.reason
        }
    }

    override fun profile(chainId: Long): String {
        val profile = defaultMobileNodeConfig(chainId.toULong())
        return "pruned sync, peers ${profile.maxPeers}, cache ${profile.maxRedbCacheMb} MiB"
    }

    override fun sync(dbPath: String, endpoint: String, chainId: Long, maxBlocks: Long): String {
        return try {
            val result = syncMobileNodePeer(dbPath, endpoint, chainId.toULong(), maxBlocks.toULong())
            if (result.success) {
                "synced ${result.syncedBlocks} blocks, tip round ${result.newTipRound}"
            } else {
                result.error ?: "light sync failed"
            }
        } catch (error: LightFfiException.Failed) {
            error.reason
        }
    }

    override fun signBatchDeployCall(
        secretKeyHex: String,
        wasmHex: String,
        method: String,
        argsHex: String,
        gasLimit: Long,
        fee: Long,
        nonce: Long,
        chainId: Long,
    ): String {
        val ktClass = Class.forName("uniffi.kovanica_light.Kovanica_lightKt")
        val fn = ktClass.methods.firstOrNull { it.name == "signBatchDeployCallRaw" }
            ?: error("signBatchDeployCallRaw requires rebuilt libkovanica_light_ffi.so from L1 >= 0aebd8f")
        return fn.invoke(
            null,
            secretKeyHex,
            wasmHex,
            method,
            argsHex,
            gasLimit.toULong(),
            fee.toULong(),
            nonce.toULong(),
            chainId.toULong(),
        ) as String
    }
}
