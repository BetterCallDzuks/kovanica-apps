package online.kovanica.node

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The FFI keystore JSON and its passphrase are sealed with an Android Keystore
 * AES key. The recovery words are never written here.
 */
object WalletStore {
    private const val ALIAS = "kovanica-node-wallet"
    private const val PREFS = "wallet-sealed"
    private const val KEY_JSON = "keystore"
    private const val KEY_PASS = "passphrase"

    fun hasWallet(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(KEY_JSON)

    fun save(context: Context, keystoreJson: String, passphrase: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit()
            .putString(KEY_JSON, seal(keystoreJson.toByteArray(Charsets.UTF_8)).toHex())
            .putString(KEY_PASS, seal(passphrase.toByteArray(Charsets.UTF_8)).toHex())
            .apply()
    }

    fun keystoreJson(context: Context): String? = open(context, KEY_JSON)

    fun passphrase(context: Context): String? = open(context, KEY_PASS)

    private fun open(context: Context, key: String): String? {
        val hex = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, null) ?: return null
        return String(unseal(hex.fromHex()), Charsets.UTF_8)
    }

    private fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secret())
        val iv = cipher.iv
        val body = cipher.doFinal(plain)
        return byteArrayOf(iv.size.toByte()) + iv + body
    }

    private fun unseal(blob: ByteArray): ByteArray {
        val ivLen = blob[0].toInt() and 0xff
        val iv = blob.copyOfRange(1, 1 + ivLen)
        val body = blob.copyOfRange(1 + ivLen, blob.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, iv))
        return cipher.doFinal(body)
    }

    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = store.getKey(ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }
}

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

private fun String.fromHex(): ByteArray {
    val out = ByteArray(length / 2)
    for (index in out.indices) {
        out[index] = substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
    return out
}
