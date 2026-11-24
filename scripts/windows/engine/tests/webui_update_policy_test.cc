#include "ardia/win/webui/webui_update_policy.h"

#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

using namespace ardia_win::webui_update;

const std::string kSha(64, 'a');
const std::string kInstaller =
    "https://github.com/ardia-browser/ardia/releases/download/windows-alpha/Ardia-Setup-x64.exe";

const std::vector<std::string> kHostileValues = {
    "",
    " ",
    "\n",
    std::string("nul\0byte", 8),
    "../../../../Windows/System32/cmd.exe",
    "..\\..\\evil.exe",
    "C:\\Windows\\System32\\cmd.exe",
    "\\\\server\\share\\evil.exe",
    "javascript:alert(1)",
    "file:///C:/Windows/System32/cmd.exe",
    "https://evil.example/Ardia-Setup-x64.exe",
    "https://github.com.evil.example/ardia-browser/ardia/releases/download/x.exe",
    "https://github.com/ardia-browser/ardia/releases/download/../../evil.exe",
    "https://github.com/ardia-browser/ardia/releases/download/a%2f..%2fevil.exe",
    "https://github.com/ardia-browser/ardia/releases/download/a?b=c.exe",
    "https://github.com/ardia-browser/ardia/releases/download/a#b.exe",
    "https://user@github.com/ardia-browser/ardia/releases/download/a.exe",
    "https://github.com/ardia-browser/ardia/releases/download//a.exe",
    "https://github.com/ardia-browser/ardia/releases/download/./a.exe",
    "https://github.com/ardia-browser/ardia/releases/download/a b.exe",
    "https://github.com/ardia-browser/ardia/releases/download/\"quoted\".exe",
    "https://github.com/ardia-browser/ardia/releases/download/caf\xc3\xa9.exe",
    "__proto__",
    "constructor",
    "1e309",
    "-1",
    "NaN",
    std::string(kUrlLimit + 1, 'a'),
};

void TestVersionsAndBuilds() {
  assert(ValidVersion("0.2.46"));
  assert(ValidVersion("0.2.47-nightly.3"));
  assert(ValidVersion("1.0.0+build.7"));
  assert(!ValidVersion(""));
  assert(!ValidVersion("v1.0.0"));
  assert(!ValidVersion("1.0 0"));
  assert(!ValidVersion("1.0.0\n"));
  assert(!ValidVersion(std::string(kVersionLimit + 1, '1')));
  assert(ValidBuild(1));
  assert(ValidBuild(kLargestBuild));
  assert(!ValidBuild(0));
  assert(!ValidBuild(kLargestBuild + 1));
  assert(ValidSha256(kSha));
  assert(!ValidSha256(std::string(64, 'A')));
  assert(!ValidSha256(std::string(63, 'a')));
  assert(!ValidSha256(std::string(64, 'g')));
  assert(ParseCount("42") == 42u);
  assert(!ParseCount("042"));
  assert(!ParseCount("0"));
  assert(!ParseCount("4 2"));
  assert(!ParseCount("12345678901234567"));
}

void TestFeedsAndUrls() {
  assert(ValidPublishedUnder(kReleasesUnder));
  assert(ValidPublishedUnder("http://127.0.0.1:8123/feed/"));
  assert(ValidPublishedUnder("http://localhost/feed/"));
  assert(ValidPublishedUnder("https://example.test/updates/"));
  assert(!ValidPublishedUnder("http://example.test/updates/"));
  assert(!ValidPublishedUnder("http://127.0.0.1:0/feed/"));
  assert(!ValidPublishedUnder("http://127.0.0.1:65536/feed/"));
  assert(!ValidPublishedUnder("https://example.test/updates"));
  assert(!ValidPublishedUnder("https:///updates/"));
  assert(!ValidPublishedUnder("https://.example.test/updates/"));
  assert(!ValidPublishedUnder("ftp://example.test/updates/"));
  assert(!ValidPublishedUnder("https://example.test//updates/"));
  assert(!ValidPublishedUnder("https://example.test/../updates/"));
  assert(!ValidPublishedUnder("https://user@example.test/updates/"));

  assert(ValidFeedUrl(kReleaseFeed));
  assert(ValidFeedUrl("http://127.0.0.1:8123/feed/windows-update.json"));
  assert(!ValidFeedUrl("http://127.0.0.1:8123/feed/windows-update.txt"));
  assert(!ValidFeedUrl("http://203.0.113.9/feed/windows-update.json"));
  assert(!ValidFeedUrl("http://127.0.0.1:8123/feed/.json"));
  assert(!ValidFeedUrl("http://127.0.0.1:8123/feed/windows-update.json?x=1"));

  const Feed release = ReleaseFeed();
  assert(release.release);
  assert(release.manifest == kReleaseFeed);
  assert(release.signature == std::string(kReleaseFeed) + ".sig");
  assert(release.published_under == kReleasesUnder);
  const std::optional<Feed> test = TestFeed("http://127.0.0.1:8123/feed/windows-update.json");
  assert(test && !test->release && test->published_under == "http://127.0.0.1:8123/feed/");
  assert(!TestFeed("https://evil.example/feed/windows-update.json?"));

  assert(ValidInstallerUrl(kInstaller, kReleasesUnder));
  assert(ValidInstallerUrl("http://127.0.0.1:8123/feed/Ardia-Setup-arm64.exe", "http://127.0.0.1:8123/feed/"));
  assert(!ValidInstallerUrl(kInstaller, "http://127.0.0.1:8123/feed/"));
  assert(!ValidInstallerUrl(std::string(kReleasesUnder) + "windows-alpha/Ardia-Setup.msi", kReleasesUnder));
  assert(!ValidInstallerUrl(std::string(kReleasesUnder) + "windows-alpha/.exe", kReleasesUnder));
  assert(!ValidInstallerUrl(std::string(kReleasesUnder) + "windows-alpha/-x.exe", kReleasesUnder));
  for (const std::string& hostile : kHostileValues) {
    assert(!ValidInstallerUrl(hostile, kReleasesUnder));
    assert(!ValidFeedUrl(hostile));
    assert(!TestFeed(hostile));
  }

  assert(AllowedRedirect("https", "objects.githubusercontent.com", 443, true));
  assert(AllowedRedirect("https", "release-assets.githubusercontent.com", 443, true));
  assert(AllowedRedirect("https", "github.com", 443, true));
  assert(!AllowedRedirect("http", "objects.githubusercontent.com", 80, true));
  assert(!AllowedRedirect("https", "objects.githubusercontent.com", 8443, true));
  assert(!AllowedRedirect("https", "evil.example", 443, true));
  assert(!AllowedRedirect("https", "objects.githubusercontent.com.evil.example", 443, true));
  assert(!AllowedRedirect("https", "objects.githubusercontent.com", 443, false));
}

void TestInstanceValues() {
  assert(InstanceValue("updateFeed=http://127.0.0.1:1/f/w.json", "updateFeed") ==
         std::optional<std::string>("http://127.0.0.1:1/f/w.json"));
  assert(InstanceValue("allowAudio, updateKey = C:\\keys\\test.pem ,updateFeed=x", "updateKey") ==
         std::optional<std::string>("C:\\keys\\test.pem"));
  assert(!InstanceValue("updateFeedX=1", "updateFeed"));
  assert(!InstanceValue("updateFeed=", "updateFeed"));
  assert(!InstanceValue("", "updateFeed"));
  assert(!InstanceValue(std::string(kInstanceLimit + 1, 'a'), "updateFeed"));
  assert(InstanceValue("updateFeed=a,updateFeed=b", "updateFeed") == std::optional<std::string>("b"));
}

void TestVerifierAnswers() {
  const std::string ok = "ok 0.3.0 120 " + kInstaller + " " + kSha + " 1048576\n";
  VerifierAnswer answer = ReadVerifierAnswer(true, 0, "noise\r\n" + ok, 100, kReleasesUnder);
  assert(answer.verdict == Verdict::kOk);
  assert(answer.offer.version == "0.3.0" && answer.offer.build == 120 && answer.offer.url == kInstaller);
  assert(answer.offer.sha256 == kSha && answer.offer.bytes == 1048576);
  assert(answer.reason.empty());

  assert(ReadVerifierAnswer(true, 0, ok, 120, kReleasesUnder).verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, ok, 100, "http://127.0.0.1:8123/feed/").verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 1, ok, 100, kReleasesUnder).verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(false, 0, ok, 100, kReleasesUnder).verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + kInstaller + " " + kSha + " 1048576 extra", 100,
                            kReleasesUnder)
             .verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + kInstaller + " " + kSha + " 0", 100, kReleasesUnder)
             .verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + kInstaller + " " + kSha + " 1073741825", 100,
                            kReleasesUnder)
             .verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + kInstaller + " " + std::string(64, 'A') + " 1", 100,
                            kReleasesUnder)
             .verdict == Verdict::kFailed);
  for (const std::string& hostile : kHostileValues) {
    const VerifierAnswer refused =
        ReadVerifierAnswer(true, 0, "ok 0.3.0 120 " + hostile + " " + kSha + " 1", 100, kReleasesUnder);
    assert(refused.verdict == Verdict::kFailed && refused.reason == kVerifierReason);
    assert(ValidVersion(hostile) ||
           ReadVerifierAnswer(true, 0, "ok " + hostile + " 120 " + kInstaller + " " + kSha + " 1", 100,
                              kReleasesUnder)
                   .verdict == Verdict::kFailed);
  }

  assert(ReadVerifierAnswer(true, 1, "failed notNewer\n", 100, kReleasesUnder).verdict == Verdict::kUpToDate);
  assert(ReadVerifierAnswer(true, 1, "failed kind", 100, kReleasesUnder).verdict == Verdict::kUpToDate);
  assert(ReadVerifierAnswer(true, 1, "failed signature", 100, kReleasesUnder).reason == kSignatureReason);
  assert(ReadVerifierAnswer(true, 1, "failed manifest", 100, kReleasesUnder).reason == kManifestReason);
  assert(ReadVerifierAnswer(true, 1, "failed version", 100, kReleasesUnder).reason == kManifestReason);
  assert(ReadVerifierAnswer(true, 1, "failed missing", 100, kReleasesUnder).reason == kMissingReason);
  assert(ReadVerifierAnswer(true, 1, "failed checksum", 100, kReleasesUnder).reason == kChecksumReason);
  assert(ReadVerifierAnswer(true, 2, "failed usage", 100, kReleasesUnder).reason == kVerifierReason);
  assert(ReadVerifierAnswer(true, 0, "failed notNewer", 100, kReleasesUnder).verdict == Verdict::kFailed);
  assert(ReadVerifierAnswer(true, 1, "", 100, kReleasesUnder).reason == kVerifierReason);
}

void TestStagingNames() {
  assert(InstallerFileName(kSha) == "Ardia-Setup-aaaaaaaaaaaaaaaa.exe");
  assert(StagingFileName(kSha, 0x0123456789abcdefull) == "Ardia-Setup-aaaaaaaaaaaaaaaa-0123456789abcdef.part");
  assert(StagingFileName(kSha, 1) != StagingFileName(kSha, 2));
  assert(InstallerFileName("..\\evil").empty());
  assert(StagingFileName("", 1).empty());
  assert(StagingFileName("..\\evil", 1).empty());
  assert(IsInstallerLeftover("Ardia-Setup-0123456789abcdef.exe"));
  assert(IsInstallerLeftover(StagingFileName(kSha, 42)));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef.exe.part"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef-0123456789ABCDEF.part"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef_0123456789abcdef.part"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef-0123456789abcde.part"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789ABCDEF.exe"));
  assert(!IsInstallerLeftover("Ardia-Setup-x64.exe"));
  assert(!IsInstallerLeftover("session.json"));
  assert(!IsInstallerLeftover("Ardia-Setup-0123456789abcdef.exe:stream"));
  assert(IsScratchName(ScratchName(4321, 7)));
  assert(ScratchName(0, 0) == "verify-1-1");
  assert(!IsScratchName("verify-1"));
  assert(!IsScratchName("verify-a-1"));
  assert(!IsScratchName("Updates"));
}

void TestCommands() {
  assert(QuoteArgument(L"C:\\Program Files\\Ardia\\x.exe") == L"\"C:\\Program Files\\Ardia\\x.exe\"");
  assert(QuoteArgument(L"C:\\dir\\") == L"\"C:\\dir\\\\\"");
  assert(QuoteArgument(L"a\"b") == L"\"a\\\"b\"");
  const VerifierPaths paths{L"C:\\A\\ardia-update-verify.exe", L"C:\\A\\windows-update.pem",
                            L"C:\\D\\Updates\\verify-1-1\\windows-update.json",
                            L"C:\\D\\Updates\\verify-1-1\\windows-update.json.sig", L""};
  const std::optional<std::wstring> manifest = VerifierCommand(paths, kReleasesUnder, "x64", 100);
  assert(manifest);
  assert(*manifest ==
         L"\"C:\\A\\ardia-update-verify.exe\" windows-manifest --key \"C:\\A\\windows-update.pem\" --manifest "
         L"\"C:\\D\\Updates\\verify-1-1\\windows-update.json\" --signature "
         L"\"C:\\D\\Updates\\verify-1-1\\windows-update.json.sig\" --published-under "
         L"\"https://github.com/ardia-browser/ardia/releases/download/\" --cpu x64 --current-build 100");
  VerifierPaths package = paths;
  package.package = L"C:\\D\\Updates\\Ardia-Setup-aaaaaaaaaaaaaaaa.exe";
  const std::optional<std::wstring> packaged = VerifierCommand(package, kReleasesUnder, "arm64", 0);
  assert(packaged && packaged->find(L" windows-package ") != std::wstring::npos &&
         packaged->ends_with(L" --package \"C:\\D\\Updates\\Ardia-Setup-aaaaaaaaaaaaaaaa.exe\""));
  assert(!VerifierCommand(paths, kReleasesUnder, "x86", 100));
  assert(!VerifierCommand(paths, "https://evil.example/x", "x64", 100));
  assert(!VerifierCommand(paths, kReleasesUnder, "x64", kLargestBuild + 1));
  VerifierPaths quoted = paths;
  quoted.manifest = L"C:\\D\\\"x";
  assert(!VerifierCommand(quoted, kReleasesUnder, "x64", 100));
  VerifierPaths broken = paths;
  broken.key = L"C:\\D\\a\nb";
  assert(!VerifierCommand(broken, kReleasesUnder, "x64", 100));
  assert(InstallerCommand(L"C:\\D\\Updates\\Ardia-Setup-aaaaaaaaaaaaaaaa.exe") ==
         L"\"C:\\D\\Updates\\Ardia-Setup-aaaaaaaaaaaaaaaa.exe\" /SILENT /SUPPRESSMSGBOXES /NORESTART "
         L"/CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS /relaunch=1");
  assert(!InstallerCommand(L""));
  assert(!InstallerCommand(L"C:\\a\"b.exe"));
  const uint8_t bytes[] = {0x00, 0x0f, 0xa0, 0xff};
  assert(HexLower(bytes, 4) == "000fa0ff");
}

void TestInstallKinds() {
  assert(InstallKind({true, true, true, true}) == kInstallerKind);
  assert(InstallKind({true, true, true, false}) == kPortableKind);
  assert(InstallKind({false, true, true, true}) == kUnsupportedKind);
  assert(InstallKind({true, false, true, true}) == kUnsupportedKind);
  assert(InstallKind({true, true, false, true}) == kUnsupportedKind);
}

void TestStateMachine() {
  const Offer offer{"0.3.0", 120, kInstaller, kSha, 1048576};
  UpdateState state;
  assert(PhaseName(state.phase) == "idle");
  assert(!BeginDownload(state, 120));
  const std::optional<int> check = BeginCheck(state);
  assert(check == 1 && PhaseName(state.phase) == "checking");
  assert(!BeginCheck(state));
  CheckFinished(state, *check + 1, Verdict::kOk, offer, "");
  assert(state.phase == Phase::kChecking);
  CheckFinished(state, *check, Verdict::kOk, offer, "");
  assert(state.phase == Phase::kAvailable && state.offer && SameOffer(*state.offer, offer));

  assert(!BeginDownload(state, 119));
  assert(!BeginDownload(state, 0));
  const std::optional<int> run = BeginDownload(state, 120);
  assert(run == 1 && state.phase == Phase::kDownloading);
  assert(!BeginCheck(state));
  assert(!BeginDownload(state, 120));
  assert(!ClaimOutcome(state, *run));
  DownloadFinished(state, *run + 1, true, "");
  assert(state.phase == Phase::kDownloading);
  DownloadFinished(state, *run, true, "");
  assert(ReadyToInstall(state));
  assert(!BeginCheck(state));
  assert(ClaimOutcome(state, *run));
  assert(!ClaimOutcome(state, *run));
  assert(!ClaimOutcome(state, 0));

  assert(BeginInstall(state) == InstallStart::kStarted);
  assert(state.installing);
  assert(BeginInstall(state) == InstallStart::kInstalling);
  assert(BeginInstall(state) == InstallStart::kInstalling);
  assert(!BeginCheck(state));
  assert(!BeginDownload(state, 120));
  InstallRefused(state, *run, kChecksumReason);
  assert(state.phase == Phase::kFailed && state.reason == kChecksumReason && !ReadyToInstall(state));
  assert(!state.installing);
  assert(BeginInstall(state) == InstallStart::kNotReady);
  assert(ClaimOutcome(state, *run));

  const std::optional<int> again = BeginCheck(state);
  assert(again == 2);
  CheckFinished(state, *again, Verdict::kUpToDate, Offer{}, "");
  assert(state.phase == Phase::kUpToDate && !state.offer && state.reason.empty());

  const std::optional<int> failing = BeginCheck(state);
  CheckFinished(state, *failing, Verdict::kFailed, Offer{}, kSignatureReason);
  assert(state.phase == Phase::kIdle && state.reason == kSignatureReason && !state.offer);

  const std::optional<int> third = BeginCheck(state);
  CheckFinished(state, *third, Verdict::kOk, offer, "");
  const std::optional<int> second_run = BeginDownload(state, 120);
  assert(second_run == 2);
  DownloadFinished(state, *second_run, false, "");
  assert(state.phase == Phase::kFailed && state.reason == kOtherReason && !state.claimed);
  assert(ClaimOutcome(state, *second_run));
  DownloadFinished(state, *second_run, true, "");
  assert(state.phase == Phase::kFailed);
  assert(PhaseName(Phase::kUpToDate) == "upToDate" && PhaseName(Phase::kAvailable) == "available" &&
         PhaseName(Phase::kDownloading) == "downloading" && PhaseName(Phase::kReady) == "ready" &&
         PhaseName(Phase::kFailed) == "failed");
}

}

int main() {
  TestVersionsAndBuilds();
  TestFeedsAndUrls();
  TestInstanceValues();
  TestVerifierAnswers();
  TestStagingNames();
  TestCommands();
  TestInstallKinds();
  TestStateMachine();
  std::cout << "webui_update_policy_test: all assertions passed\n";
  return 0;
}
