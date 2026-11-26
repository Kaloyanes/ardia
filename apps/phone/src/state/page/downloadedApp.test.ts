import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadedAppToast, opensAfterDownload } from "./pagePrompts.ts";

test("on Android a downloaded APK isn't offered an Open Ardia can't complete, and says where to install it from", () => {
  for (const name of ["Ardia-1.0.2.apk", "other.APK", " app.apk "]) assert.equal(opensAfterDownload("android", name), false, name);
  for (const name of ["report.pdf", "app.apk.txt", "apk", "photo.jpg"]) assert.equal(opensAfterDownload("android", name), true, name);
  assert.equal(opensAfterDownload("ios", "Ardia-1.0.2.apk"), true);
  assert.equal(downloadedAppToast("Ardia-1.0.2.apk"), "Downloaded Ardia-1.0.2.apk. Open it from Files to install it.");
});
