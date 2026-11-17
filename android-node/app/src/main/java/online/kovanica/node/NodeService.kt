package online.kovanica.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import io.kovanica.chain.ChainIds
import java.io.File

/**
 * Foreground service that runs the packaged full node as its own process or JNI runtime.
 * The native engine is accessed via [NativeBridge] or extracted `libkovanica_node.so`.
 * Teardown calls [NativeBridge.nodeStop] and destroys any child process.
 */
class NodeService : Service() {
    private var process: Process? = null
    private var updateThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopNode()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                initNativeBridge(this)
                startInForeground()
                startNotificationUpdater()
                if (!process.running() && binary(this).isFile) {
                    process = launch(this)
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopNode()
        super.onDestroy()
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL, "Kovanica Node", NotificationManager.IMPORTANCE_LOW)
            manager.createNotificationChannel(channel)
        }
        val info = querySyncInfo(this)
        val notification = buildNotification(this, info.syncProgress, info.committedHeight, info.peerCount)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun startNotificationUpdater() {
        if (updateThread != null) return
        val thread = Thread {
            val manager = getSystemService(NotificationManager::class.java)
            while (!Thread.currentThread().isInterrupted) {
                try {
                    Thread.sleep(5_000)
                    val info = querySyncInfo(this)
                    val notification = buildNotification(this, info.syncProgress, info.committedHeight, info.peerCount)
                    manager?.notify(NOTIFICATION_ID, notification)
                } catch (_: InterruptedException) {
                    break
                } catch (_: Throwable) {}
            }
        }
        thread.isDaemon = true
        thread.start()
        updateThread = thread
    }

    private fun stopNotificationUpdater() {
        updateThread?.interrupt()
        updateThread = null
    }

    private fun stopNode() {
        stopNotificationUpdater()
        if (NativeBridge.isNativeLoaded()) {
            try {
                NativeBridge.nodeStop()
            } catch (_: Throwable) {}
        }
        stopProcess()
    }

    private fun stopProcess() {
        val child = process ?: return
        process = null
        child.destroy()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (!child.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                    child.destroyForcibly()
                }
            } else if (!waitForExit(child, 2_000)) {
                child.destroy()
            }
        } catch (_: InterruptedException) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                child.destroyForcibly()
            } else {
                child.destroy()
            }
            Thread.currentThread().interrupt()
        }
    }

    /** `Process.isAlive` and the timed `waitFor` exist only from API 26. */
    private fun Process?.running(): Boolean {
        if (this == null) return false
        return try {
            exitValue()
            false
        } catch (_: IllegalThreadStateException) {
            true
        }
    }

    private fun waitForExit(child: Process, timeoutMs: Long): Boolean {
        val waiter = Thread {
            try {
                child.waitFor()
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        waiter.isDaemon = true
        waiter.start()
        waiter.join(timeoutMs)
        return !waiter.isAlive
    }

    data class NodeSyncInfo(
        val syncProgress: String,
        val committedHeight: Long,
        val peerCount: Long,
    )

    companion object {
        const val ACTION_STOP = "online.kovanica.node.STOP"
        private const val CHANNEL = "kovanica-node"
        private const val NOTIFICATION_ID = 54

        fun binary(context: Context): File =
            File(context.applicationInfo.nativeLibraryDir, "libkovanica_node.so")

        fun lightLibrary(context: Context): File =
            File(context.applicationInfo.nativeLibraryDir, "libkovanica_light_ffi.so")

        fun dataDir(context: Context): File = File(context.filesDir, "chaindata")

        fun configFile(context: Context): File = File(context.filesDir, "node.toml")

        fun prepare(context: Context, chainId: Long) {
            val dir = dataDir(context)
            dir.mkdirs()
            copyGenesis(context, dir, chainId)
            configFile(context).writeText(NodeConfigText.render(dir.absolutePath, chainId))
        }

        /**
         * Initializes NativeBridge with the app internal files directory on startup.
         */
        fun initNativeBridge(context: Context, chainId: Long = ChainIds.TESTNET): Int {
            prepare(context, chainId)
            val config = configFile(context)
            return if (NativeBridge.isNativeLoaded()) {
                NativeBridge.nodeStart(config.absolutePath)
            } else {
                0
            }
        }

        /**
         * Overload for file directory based initialization in tests or harness environments.
         */
        fun initNativeBridge(filesDir: File, chainId: Long = ChainIds.TESTNET): Int {
            val dir = File(filesDir, "chaindata")
            dir.mkdirs()
            val configFile = File(filesDir, "node.toml")
            if (!configFile.exists()) {
                configFile.writeText(NodeConfigText.render(dir.absolutePath, chainId))
            }
            return if (NativeBridge.isNativeLoaded()) {
                NativeBridge.nodeStart(configFile.absolutePath)
            } else {
                0
            }
        }

        /**
         * Graceful teardown stopping the native engine via nodeStop.
         */
        fun stopNativeNode(): Int {
            return if (NativeBridge.isNativeLoaded()) {
                try {
                    NativeBridge.nodeStop()
                } catch (_: Throwable) {
                    0
                }
            } else {
                0
            }
        }

        /**
         * Formats foreground notification text displaying current sync progress,
         * committed DAG height, and peer count.
         */
        fun formatNotificationText(
            syncProgress: String,
            committedHeight: Long,
            peerCount: Long,
        ): String =
            "Sync progress: $syncProgress · Committed DAG height: $committedHeight · Peer count: $peerCount"

        /**
         * Builds the foreground service notification.
         */
        fun buildNotification(
            context: Context,
            syncProgress: String = "synced",
            committedHeight: Long = 0L,
            peerCount: Long = 0L,
        ): Notification {
            val contentText = formatNotificationText(syncProgress, committedHeight, peerCount)
            val open = PendingIntent.getActivity(
                context,
                0,
                Intent(context, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE,
            )
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, CHANNEL)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            return builder
                .setContentTitle("Kovanica Node")
                .setContentText(contentText)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentIntent(open)
                .setOngoing(true)
                .build()
        }

        /**
         * Queries the current sync progress, committed height, and peer count
         * from NativeBridge and loopback RPC.
         */
        fun querySyncInfo(context: Context): NodeSyncInfo {
            var height = 0L
            var progress = "synced"
            var peers = 0L

            val progressJson = NativeBridge.safeNodeSyncProgress()
            if (progressJson.isNotEmpty() && !progressJson.contains("error")) {
                val currentHeight = RpcJson.longField(progressJson, "height")
                    ?: RpcJson.longField(progressJson, "current_height")
                val targetHeight = RpcJson.longField(progressJson, "target")
                    ?: RpcJson.longField(progressJson, "target_height")
                val peerCount = RpcJson.longField(progressJson, "peers")
                    ?: RpcJson.longField(progressJson, "peer_count")
                val catchingUp = progressJson.contains("\"catching_up\":true") ||
                    progressJson.contains("\"syncing\":true") ||
                    (targetHeight != null && currentHeight != null && targetHeight > currentHeight)
                if (currentHeight != null) {
                    height = currentHeight
                    progress = if (catchingUp) "syncing" else "synced"
                }
                if (peerCount != null) {
                    peers = peerCount
                }
            }

            try {
                val base = "http://127.0.0.1:${NodeConfigText.RPC_PORT}"
                val sync = NodeHttp.rpc(base, "kovanica_syncStatus", "[]")
                if (sync.status == 200) {
                    val rpcHeight = RpcJson.longField(sync.body, "committedHeight")
                        ?: RpcJson.longField(sync.body, "localHeight")
                        ?: RpcJson.longField(sync.body, "height")
                    val rpcPeers = RpcJson.longField(sync.body, "peerCount")
                        ?: RpcJson.longField(sync.body, "peers")
                    val catchingUp = RpcJson.boolField(sync.body, "catchingUp")
                    if (rpcHeight != null) height = rpcHeight
                    if (rpcPeers != null) peers = rpcPeers
                    if (catchingUp != null) {
                        progress = if (catchingUp) "syncing" else "synced"
                    }
                }
            } catch (_: Throwable) {}

            return NodeSyncInfo(
                syncProgress = progress,
                committedHeight = height,
                peerCount = peers,
            )
        }

        fun launch(context: Context): Process? {
            val binary = binary(context)
            if (!binary.isFile) return null
            binary.setExecutable(true, false)
            startAt(context, binary)?.let { return it }
            val copy = File(context.filesDir, "libkovanica_node.so")
            return try {
                binary.copyTo(copy, overwrite = true)
                copy.setExecutable(true, false)
                startAt(context, copy)
            } catch (_: Exception) {
                null
            }
        }

        private fun startAt(context: Context, binary: File): Process? {
            val command = NodeCommand.argv(binary.absolutePath, configFile(context).absolutePath)
            val builder = ProcessBuilder(command)
                .directory(context.filesDir)
                .redirectErrorStream(true)
            val env = builder.environment()
            env.keys.filter { it.startsWith("KOVANICA_") }.toList().forEach { env.remove(it) }
            return try {
                builder.start()
            } catch (_: Exception) {
                null
            }
        }

        private fun copyGenesis(context: Context, dir: File, chainId: Long = 2L) {
            val folder = if (chainId == 1L) "chain1" else "chain2"
            val names = when (chainId) {
                1L -> listOf("genesis_validators.toml", "founder_premine.hex", "genesis.json", "bootnodes.toml")
                else -> listOf("genesis_validators.toml", "funded_accounts.toml", "founder_premine.hex")
            }
            for (name in names) {
                val dest = File(dir, name)
                if (dest.exists()) continue
                try {
                    context.assets.open("$folder/$name").use { input ->
                        dest.outputStream().use { output -> input.copyTo(output) }
                    }
                } catch (_: Exception) {}
            }
        }
    }
}
