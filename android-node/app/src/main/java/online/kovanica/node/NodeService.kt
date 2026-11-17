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
import java.io.File

/**
 * Foreground service that runs the packaged full node as its own process.
 * The executable is `libkovanica_node.so` extracted into nativeLibraryDir.
 * Stop sends destroy, then destroyForcibly. No token is placed in the environment.
 */
class NodeService : Service() {
    private var process: Process? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopProcess()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                startInForeground()
                if (!process.running()) {
                    process = launch(this)
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopProcess()
        super.onDestroy()
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL, "Kovanica Node", NotificationManager.IMPORTANCE_LOW)
            manager.createNotificationChannel(channel)
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
            .setContentTitle("Kovanica Node")
            .setContentText("Full node is running on this device")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
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
