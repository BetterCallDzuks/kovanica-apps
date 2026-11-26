package online.kovanica.node

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
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
    private lateinit var minerAddressField: EditText
    private lateinit var miningToggleButton: Button
    private lateinit var miningThreadsButton: Button
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
            setBackgroundColor(COLOR_BG)
            val pad = dp(16)
            setPadding(pad, pad, pad, pad)
        }
        window?.decorView?.setBackgroundColor(COLOR_BG)
        window?.statusBarColor = COLOR_BG
        window?.navigationBarColor = COLOR_BG

        val header = TextView(this).apply {
            text = "Kovanica Node"
            textSize = 22f
            typeface = Typeface.SERIF
            setTextColor(COLOR_FG)
            setPadding(0, 0, 0, dp(4))
        }
        root.addView(header)
        status = text("Starting…").apply {
            background = cardDrawable(COLOR_SURFACE, COLOR_BORDER, 12)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            typeface = Typeface.MONOSPACE
            textSize = 12.5f
        }
        root.addView(status, marginParams(top = 6, bottom = 10))
        root.addView(button("Start full node", primary = true) { startFull() }, marginParams(top = 6))
        root.addView(button("Start light sync") { startLight() }, marginParams(top = 6))
        root.addView(button("Stop") { stopAll() }, marginParams(top = 6))
        root.addView(button("Retry full node") { retryFull() }, marginParams(top = 6))
        root.addView(label("Mining (Testnet)"))
        minerAddressField = styledInput("Miner reward address (kvnc…dag)").apply {
            setText(prefs().getString(KEY_MINER_ADDRESS, prefs().getString(KEY_ADDRESS, "")) ?: "")
            setSingleLine(true)
        }
        root.addView(minerAddressField, marginParams(top = 6))
        miningToggleButton = button(miningButtonLabel(), primary = true) { toggleMining() }
        root.addView(miningToggleButton, marginParams(top = 8))
        miningThreadsButton = button(miningThreadsLabel()) { cycleMiningThreads() }
        root.addView(miningThreadsButton, marginParams(top = 6))
        root.addView(label("Fallback RPC URL"))
        rpcField = styledInput("https://rpc-testnet.kovanica.online/rpc").apply {
            setText(prefs().getString(KEY_RPC, NodeHttp.DEFAULT_RPC))
            setSingleLine(true)
        }
        root.addView(rpcField, marginParams(top = 6))
        root.addView(button("Save RPC URL") { saveRpc() }, marginParams(top = 6))
        root.addView(label("Wallet"))
        addressView = text("No wallet yet").apply {
            background = cardDrawable(COLOR_SURFACE, COLOR_BORDER, 10)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            typeface = Typeface.MONOSPACE
            textSize = 12f
        }
        root.addView(addressView, marginParams(top = 6))
        qr = ImageView(this).apply {
            contentDescription = "Address QR"
            setPadding(0, dp(8), 0, dp(8))
        }
        root.addView(qr)
        root.addView(button("Create wallet", primary = true) { createWallet() }, marginParams(top = 6))
        wordsField = styledInput("Recovery words")
        root.addView(wordsField, marginParams(top = 8))
        root.addView(button("Import wallet") { importWallet() }, marginParams(top = 6))
        root.addView(button("Show recovery words") { showWords() }, marginParams(top = 6))
        root.addView(label("Send"))
        toField = styledInput("Recipient address")
        amountField = styledInput("Amount (KVNC)")
        root.addView(toField, marginParams(top = 6))
        root.addView(amountField, marginParams(top = 6))
        sendButton = button("Review and send", primary = true) { reviewSend() }
        root.addView(sendButton, marginParams(top = 8, bottom = 16))
        setContentView(ScrollView(this).apply {
            setBackgroundColor(COLOR_BG)
            addView(root)
        })
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
        // Always clear stale crash counters from older builds when the user starts the node.
        prefs().edit().putInt(KEY_CRASHES, 0).remove(KEY_REASON).apply()
        status.text = "Starting full node…"
        worker.execute {
            val decision = Fallback.readyToStart(deviceReport())
            main.post {
                if (attempt != fullAttempt.get()) return@post
                if (!decision.fullMode) {
                    rememberLight(decision.reason ?: "Full node checks did not pass.")
                    return@post
                }
                val miningEnabled = prefs().getBoolean(KEY_MINING_ENABLED, false)
                val miningThreads = prefs().getInt(KEY_MINING_THREADS, 1).coerceIn(1, 4)
                val minerAddr = currentMinerAddress()
                NodeService.prepare(
                    context = this,
                    chainId = ChainIds.TESTNET,
                    miningEnabled = miningEnabled,
                    minerAddress = minerAddr,
                    miningThreads = miningThreads,
                )
                val intent = Intent(this, NodeService::class.java)
                    .putExtra(NodeService.EXTRA_CHAIN_ID, ChainIds.TESTNET)
                    .putExtra(NodeService.EXTRA_MINING_ENABLED, miningEnabled)
                    .putExtra(NodeService.EXTRA_MINER_ADDRESS, minerAddr)
                    .putExtra(NodeService.EXTRA_MINING_THREADS, miningThreads)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent)
                } else {
                    startService(intent)
                }
                fullRunning.set(true)
                prefs().edit().putString(KEY_MODE, "full").remove(KEY_REASON).apply()
                watchProcess(attempt)
            }
        }
    }

    private fun watchProcess(attempt: Int) {
        worker.execute {
            val health = waitForHealth()
            val crashes = prefs().getInt(KEY_CRASHES, 0)
            // Keep the full node running once RPC health is up; do not kill the service
            // solely because mobile P2P peer discovery takes longer than 60 seconds.
            val decision = Fallback.decide(
                deviceReport().copy(
                    processStarted = health,
                    reachedPeer = health,
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

    private fun miningButtonLabel(): String =
        if (prefs().getBoolean(KEY_MINING_ENABLED, false)) "Mining: ON (tap to disable)" else "Mining: OFF (tap to enable)"

    private fun miningThreadsLabel(): String {
        val threads = prefs().getInt(KEY_MINING_THREADS, 1).coerceIn(1, 4)
        return "Mining threads: $threads (tap to cycle 1–4)"
    }

    private fun currentMinerAddress(): String? {
        val typed = if (::minerAddressField.isInitialized) minerAddressField.text.toString().trim() else ""
        if (typed.isNotEmpty()) {
            prefs().edit().putString(KEY_MINER_ADDRESS, typed).apply()
            return typed
        }
        return prefs().getString(KEY_MINER_ADDRESS, null)?.takeIf { it.isNotBlank() }
            ?: prefs().getString(KEY_ADDRESS, null)?.takeIf { it.isNotBlank() }
    }

    private fun toggleMining() {
        val next = !prefs().getBoolean(KEY_MINING_ENABLED, false)
        val addr = currentMinerAddress()
        if (next && addr.isNullOrBlank()) {
            tell("Create or import a wallet (or enter a kvnc…dag reward address) before enabling mining.")
            return
        }
        prefs().edit().putBoolean(KEY_MINING_ENABLED, next).apply()
        if (::miningToggleButton.isInitialized) miningToggleButton.text = miningButtonLabel()
        if (fullRunning.get()) {
            startFull()
        }
    }

    private fun cycleMiningThreads() {
        val current = prefs().getInt(KEY_MINING_THREADS, 1).coerceIn(1, 4)
        val next = if (current >= 4) 1 else current + 1
        prefs().edit().putInt(KEY_MINING_THREADS, next).apply()
        if (::miningThreadsButton.isInitialized) miningThreadsButton.text = miningThreadsLabel()
        if (fullRunning.get() && prefs().getBoolean(KEY_MINING_ENABLED, false)) {
            startFull()
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
        val runtimeAvailable = NodeService.hasNodeRuntime(this)
        val full = mode == "full" && runtimeAvailable && fullRunning.get()
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
        val miningEnabled = prefs().getBoolean(KEY_MINING_ENABLED, false)
        val miningThreads = prefs().getInt(KEY_MINING_THREADS, 1).coerceIn(1, 4)
        val cleanNetwork = if (guard.chainId == ChainIds.MAINNET) "Mainnet" else "Testnet"
        val text = buildString {
            appendLine(modeLine)
            if (full) appendLine("Mining: ${NodeService.miningTelemetry(miningEnabled, miningThreads)}")
            if (!full && profile.isNotBlank()) appendLine("Light profile: $profile")
            if (!full && lightNote.isNotBlank()) appendLine("Light sync: $lightNote")
            appendLine("Network: $cleanNetwork")
            appendLine("Sync: ${SyncState.label(phase)}")
            appendLine("Height: ${snap.committedHeight ?: "—"}")
            appendLine("Tip: ${RpcJson.shortHash(snap.tipHash)}")
            appendLine("Peers: ${snap.peerCount ?: "—"}")
            appendLine("Disk: $disk")
            appendLine("RPC: $base")
            appendLine("Balance: $balance")
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
            binaryPresent = NodeService.hasNodeRuntime(this),
            processStarted = false,
            reachedPeer = false,
            recentCrashes = prefs().getInt(KEY_CRASHES, 0),
            freeRamBytes = memory.availMem,
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

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun cardDrawable(fill: Int, stroke: Int, radiusDp: Int) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radiusDp).toFloat()
        setStroke(dp(1), stroke)
    }

    private fun marginParams(top: Int = 0, bottom: Int = 0) = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    ).apply {
        topMargin = dp(top)
        bottomMargin = dp(bottom)
    }

    private fun styledInput(hintText: String) = EditText(this).apply {
        hint = hintText
        setTextColor(COLOR_FG)
        setHintTextColor(COLOR_SUBTLE)
        typeface = Typeface.MONOSPACE
        textSize = 13f
        background = cardDrawable(COLOR_SURFACE_2, COLOR_BORDER, 10)
        setPadding(dp(12), dp(10), dp(12), dp(10))
    }

    private fun text(value: String) = TextView(this).apply {
        text = value
        setTextColor(COLOR_FG)
    }

    private fun label(value: String) = TextView(this).apply {
        text = value.uppercase()
        typeface = Typeface.MONOSPACE
        textSize = 11f
        letterSpacing = 0.14f
        setTextColor(COLOR_MUTED)
        setPadding(0, dp(20), 0, dp(4))
    }

    private fun button(value: String, primary: Boolean = false, action: () -> Unit) = Button(this).apply {
        text = value
        isAllCaps = false
        typeface = Typeface.DEFAULT_BOLD
        textSize = 14f
        setTextColor(if (primary) COLOR_GOLD_FG else COLOR_FG)
        background = cardDrawable(
            fill = if (primary) COLOR_GOLD else COLOR_SURFACE_2,
            stroke = if (primary) COLOR_GOLD else COLOR_BORDER,
            radiusDp = 10,
        )
        setPadding(dp(14), dp(12), dp(14), dp(12))
        setOnClickListener { action() }
    }

    private fun tell(message: String) {
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setMessage(message)
            .setPositiveButton("OK", null)
            .show()
    }

    private data class Screen(val text: String, val sendAllowed: Boolean)

    companion object {
        // kovanica.online dark zinc + gold + teal design tokens
        private const val COLOR_BG = 0xFF09090B.toInt()
        private const val COLOR_SURFACE = 0xFF121214.toInt()
        private const val COLOR_SURFACE_2 = 0xFF1A1A1E.toInt()
        private const val COLOR_BORDER = 0xFF2A2A30.toInt()
        private const val COLOR_FG = 0xFFF2F1EE.toInt()
        private const val COLOR_MUTED = 0xFF9A9AA3.toInt()
        private const val COLOR_SUBTLE = 0xFF6B6B74.toInt()
        private const val COLOR_GOLD = 0xFFF2A900.toInt()
        private const val COLOR_GOLD_FG = 0xFF0A0A0B.toInt()

        private const val KEY_RPC = "rpc_url"
        private const val KEY_MODE = "mode"
        private const val KEY_REASON = "reason"
        private const val KEY_CRASHES = "crashes"
        private const val KEY_ADDRESS = "address"
        private const val KEY_MINING_ENABLED = "mining_enabled"
        private const val KEY_MINING_THREADS = "mining_threads"
        private const val KEY_MINER_ADDRESS = "miner_address"
    }
}
