package online.kovanica.node

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import io.kovanica.chain.ChainIds
import java.io.File
import java.security.SecureRandom
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Node screen and a minimal KVNC wallet. The full node is a foreground
 * service. If preflight fails, the screen stays on the pruned light profile
 * and shows the reason. Mining controls are not on this screen.
 */
class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val syncer = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var rpcField: EditText
    private lateinit var addressView: TextView
    private lateinit var qr: ImageView
    private lateinit var toField: EditText
    private lateinit var amountField: EditText
    private lateinit var wordsField: EditText
    private lateinit var sendButton: Button
    private val polling = AtomicBoolean(false)
    private val lightSyncing = AtomicBoolean(false)
    private val fullRunning = AtomicBoolean(false)
    private val fullAttempt = AtomicInteger(0)

    @Volatile
    private var liveChainId: Long? = null

    @Volatile
    private var lightNote: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        FfiInstall.install()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
        }
        status = text("Starting…")
        root.addView(status)
        root.addView(button("Start full node") { startFull() })
        root.addView(button("Start light sync") { startLight() })
        root.addView(button("Stop") { stopAll() })
        root.addView(button("Retry full node") { retryFull() })
        root.addView(label("Fallback RPC URL"))
        rpcField = EditText(this).apply {
            setText(prefs().getString(KEY_RPC, NodeHttp.DEFAULT_RPC))
            setSingleLine(true)
        }
        root.addView(rpcField)
        root.addView(button("Save RPC URL") { saveRpc() })
        root.addView(label("Wallet"))
        addressView = text("No wallet yet")
        root.addView(addressView)
        qr = ImageView(this).apply { contentDescription = "Address QR" }
        root.addView(qr)
        root.addView(button("Create wallet") { createWallet() })
        wordsField = EditText(this).apply { hint = "Recovery words" }
        root.addView(wordsField)
        root.addView(button("Import wallet") { importWallet() })
        root.addView(button("Show recovery words") { showWords() })
        root.addView(label("Send"))
        toField = EditText(this).apply { hint = "Recipient address" }
        amountField = EditText(this).apply { hint = "Amount (KVNC)" }
        root.addView(toField)
        root.addView(amountField)
        sendButton = button("Review and send") { reviewSend() }
        root.addView(sendButton)
        setContentView(ScrollView(this).apply { addView(root) })
        showAddress(prefs().getString(KEY_ADDRESS, null))
        schedule()
        if (prefs().getString(KEY_MODE, null) == null) {
            startFull()
        }
    }

    override fun onDestroy() {
        polling.set(false)
        lightSyncing.set(false)
        worker.shutdownNow()
        syncer.shutdownNow()
        super.onDestroy()
    }

    private fun startFull() {
        val attempt = fullAttempt.incrementAndGet()
        status.text = "Checking whether this device can run a full node…"
        worker.execute {
            val decision = Fallback.readyToStart(deviceReport())
            main.post {
                if (attempt != fullAttempt.get()) return@post
                if (!decision.fullMode) {
                    rememberLight(decision.reason ?: "Full node checks did not pass.")
                    return@post
                }
                NodeService.prepare(this, ChainIds.TESTNET)
                startService(Intent(this, NodeService::class.java))
                fullRunning.set(true)
                prefs().edit().putString(KEY_MODE, "full").remove(KEY_REASON).apply()
                watchProcess(attempt)
            }
        }
    }

    private fun watchProcess(attempt: Int) {
        worker.execute {
            val health = waitForHealth()
            val peers = if (health) waitForPeer() else false
            val crashes = prefs().getInt(KEY_CRASHES, 0)
            val decision = Fallback.decide(
                deviceReport().copy(
                    processStarted = health,
                    reachedPeer = peers,
                    recentCrashes = crashes,
                ),
            )
            main.post {
                if (attempt != fullAttempt.get()) return@post
                if (!decision.fullMode) {
                    stopServiceOnly()
                    prefs().edit().putInt(KEY_CRASHES, crashes + 1).apply()
                    rememberLight(decision.reason ?: "Full node did not stay up.")
                }
            }
        }
    }

    private fun stopAll() {
        fullAttempt.incrementAndGet()
        lightSyncing.set(false)
        stopServiceOnly()
        prefs().edit()
            .putString(KEY_MODE, "light")
            .putString(KEY_REASON, "Stopped by the user.")
            .apply()
    }

    private fun stopServiceOnly() {
        fullRunning.set(false)
        startService(Intent(this, NodeService::class.java).setAction(NodeService.ACTION_STOP))
    }

    private fun retryFull() {
        lightSyncing.set(false)
        prefs().edit().putInt(KEY_CRASHES, 0).remove(KEY_REASON).apply()
        startFull()
    }

    private fun rememberLight(reason: String) {
        fullRunning.set(false)
        prefs().edit().putString(KEY_MODE, "light").putString(KEY_REASON, reason).apply()
        if (NativeBridge.available()) startLight()
    }

    private fun startLight() {
        if (!NativeBridge.available()) {
            tell("The light library is not packaged, so pruned sync cannot start.")
            return
        }
        if (!lightSyncing.compareAndSet(false, true)) return
        val chain = ChainGuard.agree(ChainIds.TESTNET, liveChainId)
        if (!chain.allowed) {
            lightSyncing.set(false)
            tell(chain.message)
            return
        }
        val endpoint = rpcBase()
        if (endpoint.startsWith("https://")) {
            lightSyncing.set(false)
            lightNote = "This RPC is HTTPS. Pruned sync in the light library speaks cleartext HTTP only, so height and balance stay on the status readout."
            return
        }
        syncer.execute {
            val db = File(filesDir, "light-db").absolutePath
            while (lightSyncing.get()) {
                lightNote = NativeBridge.sync(db, endpoint, chain.chainId, 4)
                try {
                    Thread.sleep(2_000)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
    }

    private fun schedule() {
        if (!polling.compareAndSet(false, true)) return
        tick()
    }

    private fun tick() {
        if (!polling.get()) return
        worker.execute {
            val view = collect()
            main.post {
                status.text = view.text
                if (::sendButton.isInitialized) sendButton.isEnabled = view.sendAllowed
                if (polling.get()) main.postDelayed({ tick() }, 5_000)
            }
        }
    }

    private fun collect(): Screen {
        val mode = prefs().getString(KEY_MODE, "light")
        val reason = prefs().getString(KEY_REASON, null)
        val binary = NodeService.binary(this).isFile
        val full = mode == "full" && binary && fullRunning.get()
        val base = if (full) "http://127.0.0.1:${NodeConfigText.RPC_PORT}" else rpcBase()
        val health = NodeHttp.get(NodeHttp.healthUrl(base))
        val sync = NodeHttp.rpc(base, "kovanica_syncStatus", "[]")
        val tips = NodeHttp.rpc(base, "kovanica_getDagTips", "[]")
        val snap = RpcJson.snapshot(health.status, health.body, sync.body + tips.body)
        liveChainId = snap.chainId ?: liveChainId
        val guard = ChainGuard.agree(ChainIds.TESTNET, snap.chainId)
        if (!guard.allowed) {
            val whenText = DateFormat.getTimeInstance().format(Date())
            return Screen(
                "$guard.message\nThis proof of concept will not use that network.\nUpdated: $whenText",
                sendAllowed = false,
            )
        }
        val phase = SyncState.fromHealth(health.status ?: sync.status, snap.catchingUp)
        val address = prefs().getString(KEY_ADDRESS, null)
        val balance = if (address != null) {
            val reply = NodeHttp.rpc(base, "kovanica_getBalance", "[\"$address\"]")
            RpcJson.quantityResult(reply.body)?.let { Amounts.format(java.math.BigInteger.valueOf(it), 9) + " KVNC" }
                ?: "unavailable"
        } else {
            "—"
        }
        val headerNote = headerCheck(base, snap.committedHeight, guard.chainId)
        val profile = if (!full) NativeBridge.profile(ChainIds.TESTNET) else ""
        val diskRoot = if (full) NodeService.dataDir(this) else File(filesDir, "light-db")
        val disk = DiskUse.format(DiskUse.bytes(diskRoot))
        val whenText = DateFormat.getTimeInstance().format(Date())
        val modeLine = if (full) {
            "Full node"
        } else {
            "Light node (fallback): ${reason ?: "full node is not running"}"
        }
        val text = buildString {
            appendLine(modeLine)
            if (!full && profile.isNotBlank()) appendLine("Light profile: $profile")
            if (!full && lightNote.isNotBlank()) appendLine("Light sync: $lightNote")
            appendLine("Network: ${guard.networkName}")
            appendLine("Sync: ${SyncState.label(phase)}")
            appendLine("Height: ${snap.committedHeight ?: "—"}")
            appendLine("Tip: ${RpcJson.shortHash(snap.tipHash)}")
            appendLine("Peers: ${snap.peerCount ?: "—"}")
            appendLine("Disk: $disk")
            appendLine("RPC: $base")
            appendLine("Balance: $balance")
            appendLine("Header check: $headerNote")
            append("Updated: $whenText")
        }
        return Screen(text, sendAllowed = true)
    }

    private fun headerCheck(base: String, height: Long?, chainId: Long): String {
        if (!NativeBridge.available() || height == null || height <= 0L) {
            return if (NativeBridge.available()) "waiting for a height" else "native library is not packaged"
        }
        val reply = NodeHttp.rpc(base, "kovanica_getBlockHeaderByNumber", "[$height]")
        val header = RpcJson.resultValue(reply.body) ?: return "header unavailable"
        val parent = if (height > 1L) {
            val previous = NodeHttp.rpc(base, "kovanica_getBlockHeaderByNumber", "[${height - 1}]")
            RpcJson.resultValue(previous.body).orEmpty()
        } else {
            ""
        }
        return NativeBridge.verifyHeader(chainId, header, parent)
    }

    private fun deviceReport(): Fallback.Report {
        val stat = StatFs(filesDir.absolutePath)
        val free = stat.availableBlocksLong * stat.blockSizeLong
        val memory = ActivityManager.MemoryInfo()
        (getSystemService(ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory)
        return Fallback.Report(
            freeDiskBytes = free,
            totalRamBytes = memory.totalMem,
            abi = Build.SUPPORTED_ABIS.firstOrNull().orEmpty(),
            binaryPresent = NodeService.binary(this).isFile,
            processStarted = false,
            reachedPeer = false,
            recentCrashes = prefs().getInt(KEY_CRASHES, 0),
        )
    }

    private fun waitForHealth(): Boolean {
        val base = "http://127.0.0.1:${NodeConfigText.RPC_PORT}"
        val deadline = System.currentTimeMillis() + 25_000
        while (System.currentTimeMillis() < deadline) {
            val reply = NodeHttp.get(NodeHttp.healthUrl(base))
            if (reply.status == 200 || reply.status == 503) return true
            try {
                Thread.sleep(500)
            } catch (_: InterruptedException) {
                return false
            }
        }
        return false
    }

    private fun waitForPeer(): Boolean {
        val base = "http://127.0.0.1:${NodeConfigText.RPC_PORT}"
        val deadline = System.currentTimeMillis() + 60_000
        while (System.currentTimeMillis() < deadline) {
            val reply = NodeHttp.rpc(base, "kovanica_syncStatus", "[]")
            val peers = RpcJson.longField(reply.body, "peerCount") ?: 0
            if (peers > 0) return true
            try {
                Thread.sleep(1_000)
            } catch (_: InterruptedException) {
                return false
            }
        }
        return false
    }

    private fun saveRpc() {
        val value = rpcField.text.toString().trim().ifEmpty { NodeHttp.DEFAULT_RPC }
        prefs().edit().putString(KEY_RPC, value).apply()
        rpcField.setText(value)
    }

    private fun rpcBase(): String =
        prefs().getString(KEY_RPC, NodeHttp.DEFAULT_RPC) ?: NodeHttp.DEFAULT_RPC

    private fun createWallet() {
        if (!NativeBridge.available()) {
            tell("The native library is not packaged, so a wallet cannot be created in this build.")
            return
        }
        worker.execute {
            try {
                val pass = randomPass()
                val created = NativeBridge.createHd(pass)
                WalletStore.save(this, created.keystoreJson, pass)
                prefs().edit().putString(KEY_ADDRESS, created.address).apply()
                main.post {
                    showAddress(created.address)
                    tell("Wallet created. Use Show recovery words to see the phrase once.")
                }
            } catch (_: Exception) {
                main.post { tell("Could not create the wallet.") }
            }
        }
    }

    private fun importWallet() {
        if (!NativeBridge.available()) {
            tell("The native library is not packaged, so a wallet cannot be imported in this build.")
            return
        }
        val words = wordsField.text.toString().trim()
        wordsField.setText("")
        if (words.isEmpty()) {
            tell("Enter the recovery words, then import.")
            return
        }
        worker.execute {
            try {
                val pass = randomPass()
                val imported = NativeBridge.importHd(words, pass)
                WalletStore.save(this, imported.keystoreJson, pass)
                prefs().edit().putString(KEY_ADDRESS, imported.address).apply()
                main.post { showAddress(imported.address) }
            } catch (_: Exception) {
                main.post { tell("Those recovery words were not accepted.") }
            }
        }
    }

    private fun showWords() {
        if (!NativeBridge.available() || !WalletStore.hasWallet(this)) {
            tell("There is no wallet to reveal, or the native library is not packaged.")
            return
        }
        worker.execute {
            try {
                val json = WalletStore.keystoreJson(this) ?: return@execute
                val pass = WalletStore.passphrase(this) ?: return@execute
                val words = NativeBridge.reveal(json, pass)
                main.post {
                    AlertDialog.Builder(this)
                        .setTitle("Recovery words")
                        .setMessage(words)
                        .setPositiveButton("Hide", null)
                        .show()
                }
            } catch (_: Exception) {
                main.post { tell("Could not reveal the recovery words.") }
            }
        }
    }

    private fun reviewSend() {
        val guard = ChainGuard.agree(ChainIds.TESTNET, liveChainId)
        if (!guard.allowed) {
            tell(guard.message)
            return
        }
        val to = toField.text.toString()
        val amount = amountField.text.toString()
        val base = if (fullRunning.get()) "http://127.0.0.1:${NodeConfigText.RPC_PORT}" else rpcBase()
        worker.execute {
            val rate = RpcJson.quantityResult(NodeHttp.rpc(base, "kovanica_estimateFee", "[]").body)
            val review = SendFlow.review(guard.chainId, to, amount, rate)
            main.post {
                val value = review.getOrElse {
                    tell(it.message ?: "Cannot send")
                    return@post
                }
                AlertDialog.Builder(this)
                    .setTitle("Confirm send")
                    .setMessage(
                        "Network: ${value.networkName}\nTo: ${value.to}\nAmount: ${value.amountText}\nFee: ${value.feeText}",
                    )
                    .setNegativeButton("Cancel", null)
                    .setPositiveButton("Confirm") { _, _ -> submit(value) }
                    .show()
            }
        }
    }

    private fun submit(review: SendReview) {
        if (!NativeBridge.available() || !WalletStore.hasWallet(this)) {
            tell("Signing needs the native library and a wallet on this device.")
            return
        }
        val sender = prefs().getString(KEY_ADDRESS, null)
        if (sender.isNullOrBlank()) {
            tell("Create or import a wallet before sending.")
            return
        }
        val base = if (fullRunning.get()) "http://127.0.0.1:${NodeConfigText.RPC_PORT}" else rpcBase()
        worker.execute {
            try {
                val json = WalletStore.keystoreJson(this) ?: return@execute
                val pass = WalletStore.passphrase(this) ?: return@execute
                val nonceReply = NodeHttp.rpc(base, "kovanica_getNonce", "[\"$sender\"]")
                val nonce = RpcJson.quantityResult(nonceReply.body)
                if (nonce == null) {
                    main.post { tell("Could not read the sending account nonce.") }
                    return@execute
                }
                val raw = NativeBridge.signTransfer(
                    json,
                    pass,
                    review.chainId,
                    review.to,
                    review.amountAtoms.toLong(),
                    review.feeAtoms.toLong(),
                    nonce,
                )
                val hex = if (raw.startsWith("0x") || raw.startsWith("0X")) raw else "0x$raw"
                val sent = NodeHttp.rpc(base, "kovanica_sendRawTransaction", "[\"$hex\"]")
                val kind = Submission.classify(sent.status ?: 0, sent.body)
                val message = when (kind) {
                    SubmitKind.ACCEPTED -> "Submitted."
                    SubmitKind.NEEDS_WRITE_RPC -> Submission.WRITE_RPC_MESSAGE
                    SubmitKind.REJECTED -> "The node rejected the transaction."
                }
                main.post { tell(message) }
            } catch (_: Exception) {
                main.post { tell("Could not sign the transaction.") }
            }
        }
    }

    private fun showAddress(address: String?) {
        if (address.isNullOrBlank()) {
            addressView.text = "No wallet yet"
            qr.setImageBitmap(null)
            return
        }
        addressView.text = address
        qr.setImageBitmap(qrBitmap(address))
    }

    private fun qrBitmap(text: String): Bitmap {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 512, 512)
        val bitmap = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.RGB_565)
        for (x in 0 until matrix.width) {
            for (y in 0 until matrix.height) {
                bitmap.setPixel(x, y, if (matrix.get(x, y)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt())
            }
        }
        return bitmap
    }

    private fun randomPass(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun prefs() = getSharedPreferences("node", MODE_PRIVATE)

    private fun text(value: String) = TextView(this).apply { text = value }

    private fun label(value: String) = TextView(this).apply {
        text = value
        setPadding(0, 24, 0, 0)
    }

    private fun button(value: String, action: () -> Unit) = Button(this).apply {
        text = value
        setOnClickListener { action() }
    }

    private fun tell(message: String) {
        AlertDialog.Builder(this).setMessage(message).setPositiveButton("OK", null).show()
    }

    private data class Screen(val text: String, val sendAllowed: Boolean)

    companion object {
        private const val KEY_RPC = "rpc_url"
        private const val KEY_MODE = "mode"
        private const val KEY_REASON = "reason"
        private const val KEY_CRASHES = "crashes"
        private const val KEY_ADDRESS = "address"
    }
}
