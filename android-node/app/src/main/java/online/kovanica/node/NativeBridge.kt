package online.kovanica.node

/**
 * Calls into `libkovanica_ffi.so` (native mobile node engine) and
 * `libkovanica_light_ffi.so` (UniFFI wallet/crypto functions).
 * Until libraries are packaged, calls report that the native library is absent.
 * No seed, token or recovery words are logged.
 */
object NativeBridge {
    data class Created(val address: String, val keystoreJson: String)

    private var nativeLoaded: Boolean = false

    init {
        try {
            System.loadLibrary("kovanica_ffi")
            nativeLoaded = true
        } catch (_: UnsatisfiedLinkError) {
            nativeLoaded = false
        }
    }

    fun isNativeLoaded(): Boolean = nativeLoaded

    @JvmStatic
    external fun nodeStart(configPath: String): Int

    @JvmStatic
    external fun nodeStop(): Int

    @JvmStatic
    external fun nodeStatus(): String

    @JvmStatic
    external fun nodeSyncProgress(): String

    fun safeNodeSyncProgress(): String {
        return if (nativeLoaded) {
            try {
                nodeSyncProgress()
            } catch (_: Throwable) {
                """{"height":0,"target":0,"peers":0,"error":"native call failed"}"""
            }
        } else {
            """{"height":0,"target":0,"peers":0,"error":"native library is not packaged"}"""
        }
    }

    fun available(): Boolean = impl != null || nativeLoaded

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

    /**
     * Wave A atomic 1-tx Deploy + Call batch signer (bound to `sign_batch_deploy_call_raw`
     * in `kovanica-light-ffi`).
     */
    fun signBatchDeployCall(
        secretKeyHex: String,
        wasmHex: String,
        method: String,
        argsHex: String,
        gasLimit: Long,
        fee: Long,
        nonce: Long,
        chainId: Long,
    ): String = impl?.signBatchDeployCall(
        secretKeyHex,
        wasmHex,
        method,
        argsHex,
        gasLimit,
        fee,
        nonce,
        chainId,
    ) ?: error("native library is not packaged")

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
        fun signBatchDeployCall(
            secretKeyHex: String,
            wasmHex: String,
            method: String,
            argsHex: String,
            gasLimit: Long,
            fee: Long,
            nonce: Long,
            chainId: Long,
        ): String = error("sign_batch_deploy_call_raw not available in packaged libkovanica_light_ffi")
    }
}
