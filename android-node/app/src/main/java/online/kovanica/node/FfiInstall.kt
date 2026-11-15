package online.kovanica.node

/**
 * Loads the UniFFI wrapper when `libkovanica_light_ffi.so` is packaged.
 * A missing library leaves [NativeBridge.impl] null and the screen says so.
 * Recovery words are not read here.
 */
object FfiInstall {
    @Volatile
    private var attempted = false

    fun install() {
        if (attempted) return
        attempted = true
        try {
            val bridge = Class.forName("online.kovanica.node.LightFfiBridge")
                .getDeclaredConstructor()
                .newInstance() as NativeBridge.Bridge
            bridge.profile(io.kovanica.chain.ChainIds.TESTNET)
            NativeBridge.impl = bridge
        } catch (_: Throwable) {
            NativeBridge.impl = null
        }
    }
}
