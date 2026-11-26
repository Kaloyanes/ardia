package com.ardia.phone

import java.io.ByteArrayInputStream
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AppUpdateInstallerTest {
    private val context = RuntimeEnvironment.getApplication()
    private val apk = ByteArray(200_000) { (it * 13).toByte() }
    private val sha256 = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }

    private fun install(expected: String?) = AppUpdateInstaller.install(context, ByteArrayInputStream(apk), apk.size.toLong(), expected, AppUpdateInstaller.KIND_UPDATE)

    @Test
    fun withoutTheInstallPermissionNoSessionIsOpened() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(false)
        assertEquals("needs_permission", install(sha256))
        assertTrue(context.packageManager.packageInstaller.allSessions.isEmpty())
    }

    @Test
    fun bytesThatDontMatchTheChecksumAreAbandonedBeforeCommit() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        assertEquals("mismatch", install("0".repeat(64)))
        assertTrue(context.packageManager.packageInstaller.allSessions.isEmpty())
    }

    @Test
    fun matchingBytesAreCommittedToTheSession() {
        shadowOf(context.packageManager).setCanRequestPackageInstalls(true)
        assertEquals("committed", install(sha256))
    }
}
