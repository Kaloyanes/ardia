package com.ardia.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppUpdateHandoffTest {
    private val base = "https://github.com/ardia-browser/ardia/releases/download"

    @Test
    fun takesOnlyThisRepositorysReleaseApk() {
        assertEquals("Ardia-1.0.2.apk", AppUpdateHandoff.releaseApkName("$base/android-v1.0.2/Ardia-1.0.2.apk"))
        assertEquals("Ardia-1.0.3-nightly.2.apk", AppUpdateHandoff.releaseApkName("$base/android-v1.0.3-nightly.2/Ardia-1.0.3-nightly.2.apk"))
        listOf(
            "$base/android-v1.0.2/Ardia-1.0.3.apk",
            "$base/android-v1.0.02/Ardia-1.0.02.apk",
            "$base/android-v1.0.2/Ardia-1.0.2.apk?x=1",
            "$base/android-v1.0.2/Ardia-1.0.2.apk#x",
            "$base/android-v1.0.2/Ardia-1.0.2.apk\n",
            "$base/android-v1.0.2/../android-v1.0.2/Ardia-1.0.2.apk",
            "http://github.com/ardia-browser/ardia/releases/download/android-v1.0.2/Ardia-1.0.2.apk",
            "https://github.com.evil.example/ardia-browser/ardia/releases/download/android-v1.0.2/Ardia-1.0.2.apk",
            "https://user@github.com/ardia-browser/ardia/releases/download/android-v1.0.2/Ardia-1.0.2.apk",
            "https://github.com/someone/ardia/releases/download/android-v1.0.2/Ardia-1.0.2.apk",
            "javascript:alert(1)",
            "file:///sdcard/Download/Ardia-1.0.2.apk",
            "",
            "$base/android-v1.0.2/Ardia-1.0.2.apk" + "x".repeat(300),
        ).forEach { assertNull(it, AppUpdateHandoff.releaseApkName(it)) }
    }
}
