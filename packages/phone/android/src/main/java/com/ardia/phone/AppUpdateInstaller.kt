package com.ardia.phone

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

internal object AppUpdateInstaller {
    const val KIND_UPDATE = "update"
    const val KIND_FILE = "file"
    private const val EXTRA_KIND = "com.ardia.phone.INSTALL_KIND"
    private val SHA256 = Regex("^[0-9a-f]{64}$")

    @Volatile var statusSink: ((Map<String, Any?>) -> Unit)? = null
    @Volatile private var unreported: Map<String, Any?>? = null

    fun installFile(context: Context, file: File, sha256: String): String {
        if (!SHA256.matches(sha256) || !file.isFile) return "gone"
        return runCatching { file.inputStream().use { install(context, it, file.length(), sha256, KIND_UPDATE) } }.getOrDefault("failed")
    }

    fun installStream(context: Context, input: InputStream, length: Long): String =
        runCatching { input.use { install(context, it, length, null, KIND_FILE) } }.getOrDefault("failed")

    fun install(context: Context, input: InputStream, length: Long, sha256: String?, kind: String): String {
        if (!AppUpdateHandoff.canInstallPackages(context)) return "needs_permission"
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (kind == KIND_UPDATE) params.setAppPackageName(context.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        var committed = false
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            session.openWrite("base.apk", 0, if (length > 0) length else -1).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                }
                session.fsync(output)
            }
            if (sha256 != null && digest.digest().joinToString("") { "%02x".format(it) } != sha256) return "mismatch"
            val status = Intent(context, AppUpdateInstallReceiver::class.java).setPackage(context.packageName).putExtra(EXTRA_KIND, kind)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(context, sessionId, status, flags).intentSender)
            committed = true
            return "committed"
        } finally {
            if (!committed) runCatching { session.abandon() }
            runCatching { session.close() }
        }
    }

    fun report(context: Context, intent: Intent) {
        val kind = intent.getStringExtra(EXTRA_KIND) ?: KIND_UPDATE
        val outcome = when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> if (confirm(context, intent)) "confirming" else "aborted"
            PackageInstaller.STATUS_SUCCESS -> "success"
            PackageInstaller.STATUS_FAILURE_ABORTED -> "aborted"
            else -> "failure"
        }
        val event = mapOf("kind" to kind, "status" to outcome)
        val sink = statusSink
        if (sink != null) sink(event) else unreported = event
    }

    fun takeUnreported(): Map<String, Any?>? = unreported.also { unreported = null }

    @Suppress("DEPRECATION")
    private fun confirm(context: Context, intent: Intent): Boolean {
        val confirmation = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)) ?: return false
        return runCatching { context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
    }
}

class AppUpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = AppUpdateInstaller.report(context, intent)
}
