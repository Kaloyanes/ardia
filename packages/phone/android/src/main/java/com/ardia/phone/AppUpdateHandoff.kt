package com.ardia.phone

import android.app.Activity
import android.app.DownloadManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Environment

internal object AppUpdateHandoff {
    const val APK_MIME = "application/vnd.android.package-archive"
    private const val DOWNLOADS_PROVIDER = "com.android.providers.downloads"
    private val RELEASE_APK = Regex("^https://github\\.com/ardia-browser/ardia/releases/download/android-v((?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})(?:-nightly\\.(?:0|[1-9][0-9]{0,8}))?)/Ardia-([0-9A-Za-z.-]{1,40})\\.apk$")

    fun releaseApkName(url: String): String? {
        if (url.length > 300) return null
        val match = RELEASE_APK.matchEntire(url) ?: return null
        val version = match.groupValues[1]
        return if (match.groupValues[2] == version) "Ardia-$version.apk" else null
    }

    fun start(context: Context, activity: Activity?, url: String, title: String): String {
        val fileName = releaseApkName(url) ?: return "unavailable"
        if (enqueue(context, url, fileName, title)) return "notifications"
        if (openElsewhere(context, activity, url, title)) return "browser"
        return "unavailable"
    }

    private fun downloadManagerEnabled(context: Context): Boolean {
        val state = runCatching { context.packageManager.getApplicationEnabledSetting(DOWNLOADS_PROVIDER) }.getOrNull() ?: return false
        return state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT || state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
    }

    private fun enqueue(context: Context, url: String, fileName: String, title: String): Boolean {
        if (!downloadManagerEnabled(context)) return false
        val manager = context.getSystemService(DownloadManager::class.java) ?: return false
        return runCatching {
            val request = DownloadManager.Request(Uri.parse(url))
                .setMimeType(APK_MIME)
                .setTitle(title)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            manager.enqueue(request) > 0
        }.getOrDefault(false)
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
        val starter: Context = activity ?: context
        if (starter !is Activity) launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { starter.startActivity(launch) }.isSuccess
    }
}
