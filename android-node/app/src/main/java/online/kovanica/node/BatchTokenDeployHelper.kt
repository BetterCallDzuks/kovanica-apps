package online.kovanica.node

/**
 * Wave A 1-tap atomic Deploy + Call batch helper for Android.
 *
 * Uses [NativeBridge.signBatchDeployCall] (backed by `sign_batch_deploy_call_raw`
 * in `libkovanica_light_ffi.so` rebuilt from `kovanica-l1 >= ea8d5fd`) to combine
 * contract deployment (1 KVNC floor) and initialization (`token_create` 5 KVNC
 * or `rwa_create` 10 KVNC) into a single atomic transaction.
 */
object BatchTokenDeployHelper {
    const val FIXED_FEE_DEPLOY_ATOMS: Long = 1_000_000_000L
    const val FIXED_FEE_TOKEN_CREATE_ATOMS: Long = 5_000_000_000L
    const val FIXED_FEE_RWA_CREATE_ATOMS: Long = 10_000_000_000L
    const val DEFAULT_BATCH_GAS_LIMIT: Long = 5_000_000L

    /** Sign a 1-tx atomic `Deploy + token_create` batch transaction. */
    fun signTokenCreateBatch(
        secretKeyHex: String,
        tokenWasmHex: String,
        tokenCreateArgsHex: String,
        nonce: Long,
        chainId: Long,
        feeAtoms: Long = FIXED_FEE_DEPLOY_ATOMS + FIXED_FEE_TOKEN_CREATE_ATOMS,
    ): String = NativeBridge.signBatchDeployCall(
        secretKeyHex = secretKeyHex,
        wasmHex = tokenWasmHex,
        method = "token_create",
        argsHex = tokenCreateArgsHex,
        gasLimit = DEFAULT_BATCH_GAS_LIMIT,
        fee = feeAtoms,
        nonce = nonce,
        chainId = chainId,
    )

    /** Sign a 1-tx atomic `Deploy + rwa_create` (KVP-106) batch transaction. */
    fun signRwaCreateBatch(
        secretKeyHex: String,
        rwaWasmHex: String,
        rwaCreateArgsHex: String,
        nonce: Long,
        chainId: Long,
        feeAtoms: Long = FIXED_FEE_DEPLOY_ATOMS + FIXED_FEE_RWA_CREATE_ATOMS,
    ): String = NativeBridge.signBatchDeployCall(
        secretKeyHex = secretKeyHex,
        wasmHex = rwaWasmHex,
        method = "rwa_create",
        argsHex = rwaCreateArgsHex,
        gasLimit = DEFAULT_BATCH_GAS_LIMIT,
        fee = feeAtoms,
        nonce = nonce,
        chainId = chainId,
    )
}
