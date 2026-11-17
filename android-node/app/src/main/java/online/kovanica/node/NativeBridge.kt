package online.kovanica.node

/**
 * Calls into `libkovanica_light_ffi.so` once the UniFFI classes built from
 * L1 9a3813c are on the classpath. Until that library is packaged, every
 * call reports that the native library is absent. No seed, token or
 * recovery words are logged.
 */
object NativeBridge {
    data class Created(val address: String, val keystoreJson: String)

    fun available(): Boolean = impl != null

    fun createHd(passphrase: String): Created =
        impl?.createHd(passphrase) ?: error("native library is not packaged")

    fun importHd(mnemonic: String, passphrase: String): Created =
        impl?.importHd(mnemonic, passphrase) ?: error("native library is not packaged")

    fun reveal(keystoreJson: String, passphrase: String): String =
        impl?.reveal(keystoreJson, passphrase) ?: error("native library is not packaged")

    fun signTransfer(
        keystoreJson: String,
        passphrase: String,
        chainId: Long,
        to: String,
        amount: Long,
        fee: Long,
        nonce: Long,
    ): String = impl?.signTransfer(keystoreJson, passphrase, chainId, to, amount, fee, nonce)
        ?: error("native library is not packaged")

    fun verifyHeader(chainId: Long, headerJson: String, parentJson: String): String =
        impl?.verifyHeader(chainId, headerJson, parentJson) ?: "native library is not packaged"

    fun profile(chainId: Long): String =
        impl?.profile(chainId) ?: "native library is not packaged"

    fun sync(dbPath: String, endpoint: String, chainId: Long, maxBlocks: Long): String =
        impl?.sync(dbPath, endpoint, chainId, maxBlocks) ?: "native library is not packaged"

    /** Installed by the generated UniFFI wrapper when that class loads. */
    @Volatile
    var impl: Bridge? = null

    interface Bridge {
        fun createHd(passphrase: String): Created
        fun importHd(mnemonic: String, passphrase: String): Created
        fun reveal(keystoreJson: String, passphrase: String): String
        fun signTransfer(
            keystoreJson: String,
            passphrase: String,
            chainId: Long,
            to: String,
            amount: Long,
            fee: Long,
            nonce: Long,
        ): String
        fun verifyHeader(chainId: Long, headerJson: String, parentJson: String): String
        fun profile(chainId: Long): String
        fun sync(dbPath: String, endpoint: String, chainId: Long, maxBlocks: Long): String
    }
}
