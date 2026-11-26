package com.ardia.phone

import android.app.Activity
import android.app.DownloadManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest

class AppUpdateFileProvider : FileProvider()

internal object AppUpdateHandoff {
    const val APK_MIME = "application/vnd.android.package-archive"
    private const val DOWNLOADS_PROVIDER = "com.android.providers.downloads"
    private const val UPDATES_DIR = "updates"
    private val RELEASE_APK = Regex("^https://github\\.com/ardia-browser/ardia/releases/download/android-v((?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})(?:-nightly\\.(?:0|[1-9][0-9]{0,8}))?)/Ardia-([0-9A-Za-z.-]{1,40})\\.apk$")
    private val APK_FILE = Regex("^Ardia-[0-9A-Za-z.-]{1,40}\\.apk$")
    private val SHA256 = Regex("^[0-9a-f]{64}$")

    fun releaseApkName(url: String): String? {
        if (url.length > 300) return null
        val match = RELEASE_APK.matchEntire(url) ?: return null
        val version = match.groupValues[1]
        return if (match.groupValues[2] == version) "Ardia-$version.apk" else null
    }

    fun start(context: Context, activity: Activity?, url: String, title: String): Map<String, Any?> {
        val fileName = releaseApkName(url) ?: return mapOf("handoff" to "unavailable")
        enqueue(context, url, fileName, title)?.let { return mapOf("handoff" to "notifications", "id" to it.toString()) }
        if (openElsewhere(context, activity, url, title)) return mapOf("handoff" to "browser")
        return mapOf("handoff" to "unavailable")
    }

    fun status(context: Context, id: String): String {
        val number = id.toLongOrNull()?.takeIf { it > 0 } ?: return "gone"
        val manager = context.getSystemService(DownloadManager::class.java) ?: return "gone"
        return runCatching {
            manager.query(DownloadManager.Query().setFilterById(number))?.use { cursor ->
                if (!cursor.moveToFirst()) return@use "gone"
                when (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                    DownloadManager.STATUS_PENDING -> "pending"
                    DownloadManager.STATUS_RUNNING -> "running"
                    DownloadManager.STATUS_PAUSED -> "paused"
                    DownloadManager.STATUS_SUCCESSFUL -> "successful"
                    DownloadManager.STATUS_FAILED -> "failed"
                    else -> "gone"
                }
            } ?: "gone"
        }.getOrDefault("gone")
    }

    fun install(context: Context, activity: Activity?, id: String, sha256: String, fileName: String): String {
        if (!SHA256.matches(sha256) || !APK_FILE.matches(fileName)) return "failed"
        val number = id.toLongOrNull()?.takeIf { it > 0 } ?: return "gone"
        if (status(context, id) != "successful") return "gone"
        val manager = context.getSystemService(DownloadManager::class.java) ?: return "gone"
        val directory = File(context.cacheDir, UPDATES_DIR).apply { mkdirs() }
        directory.listFiles()?.filter { it.name != fileName }?.forEach { it.delete() }
        val copy = File(directory, fileName)
        val matched = runCatching {
            manager.openDownloadedFile(number).use { descriptor -> FileInputStream(descriptor.fileDescriptor).use { verifiedCopy(it, copy, sha256) } }
        }.getOrNull() ?: return "gone"
        if (!matched) {
            runCatching { manager.remove(number) }
            return "mismatch"
        }
        return launchInstaller(context, activity, FileProvider.getUriForFile(context, "${context.packageName}.updates", copy))
    }

    fun discard(context: Context, id: String): Boolean {
        val number = id.toLongOrNull()?.takeIf { it > 0 } ?: return false
        File(context.cacheDir, UPDATES_DIR).listFiles()?.forEach { it.delete() }
        return runCatching { (context.getSystemService(DownloadManager::class.java)?.remove(number) ?: 0) > 0 }.getOrDefault(false)
    }

    fun verifiedCopy(input: InputStream, destination: File, sha256: String): Boolean {
        val digest = MessageDigest.getInstance("SHA-256")
        val partial = File(destination.parentFile, "${destination.name}.part")
        partial.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
                output.write(buffer, 0, read)
            }
        }
        val found = digest.digest().joinToString("") { "%02x".format(it) }
        destination.delete()
        if (found != sha256) {
            partial.delete()
            return false
        }
        return partial.renameTo(destination)
    }

    fun canInstallPackages(context: Context): Boolean = runCatching { context.packageManager.canRequestPackageInstalls() }.getOrDefault(false)

    fun openInstallPermission(context: Context, activity: Activity?): Boolean {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        return startFrom(context, activity, intent)
    }

    fun installDownloadedFile(context: Context, activity: Activity?, uri: String): String {
        val parsed = Uri.parse(uri)
        if (parsed.scheme != "content") return "failed"
        return launchInstaller(context, activity, parsed)
    }

    private fun launchInstaller(context: Context, activity: Activity?, uri: Uri): String {
        if (!canInstallPackages(context)) return "needs_permission"
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, APK_MIME).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        return if (startFrom(context, activity, intent)) "launched" else "failed"
    }

    private fun startFrom(context: Context, activity: Activity?, intent: Intent): Boolean {
        val starter: Context = activity ?: context
        if (starter !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { starter.startActivity(intent) }.isSuccess
    }

    private fun downloadManagerEnabled(context: Context): Boolean {
        val state = runCatching { context.packageManager.getApplicationEnabledSetting(DOWNLOADS_PROVIDER) }.getOrNull() ?: return false
        return state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT || state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
    }

    private fun enqueue(context: Context, url: String, fileName: String, title: String): Long? {
        if (!downloadManagerEnabled(context)) return null
        val manager = context.getSystemService(DownloadManager::class.java) ?: return null
        return runCatching {
            val request = DownloadManager.Request(Uri.parse(url))
                .setMimeType(APK_MIME)
                .setTitle(title)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            manager.enqueue(request)
        }.getOrNull()?.takeIf { it > 0 }
    }

    @Suppress("DEPRECATION")
    private fun openElsewhere(context: Context, activity: Activity?, url: String, title: String): Boolean {
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
        val handlers = runCatching { context.packageManager.queryIntentActivities(view, PackageManager.MATCH_DEFAULT_ONLY) }.getOrDefault(emptyList())
        val own = handlers.filter { it.activityInfo.packageName == context.packageName }.map { ComponentName(it.activityInfo.packageName, it.activityInfo.name) }
        val others = handlers.filter { it.activityInfo.packageName != context.packageName }
        if (others.isEmpty()) return false
        val launch = if (others.size == 1) {
            view.setComponent(ComponentName(others[0].activityInfo.packageName, others[0].activityInfo.name))
        } else {
            Intent.createChooser(view, title).putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, own.toTypedArray())
        }
        return startFrom(context, activity, launch)
    }
}
