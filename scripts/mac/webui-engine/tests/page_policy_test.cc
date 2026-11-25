#include "ardia/mac/ac_mac_page_policy.h"

#include <array>
#include <limits>
#include <string>
#include <string_view>
#include <vector>

#include "check.h"

namespace policy = ardia_mac::page_policy;

namespace {

std::string Identity(std::string_view text) {
  return std::string(text);
}

constexpr std::array<std::string_view, 2> kFonts = {{"serif", "sans"}};

}

TEST(page_commands_are_the_shared_webview_handle_names) {
  for (std::string_view command :
       {"find", "stopFinding", "print", "runPageCommand", "showDevTools", "zoomStep",
        "goToOffset", "evaluate", "edit", "getSecurityInfo", "discard", "sleepIfHidden",
        "setFrozen", "downloadFavicon", "downloadImage", "openBlockedPopup",
        "resolveUnresponsive"}) {
    CHECK(policy::Handles(command));
  }
  for (std::string_view other : {"loadUrl", "goBack", "reload", "close", "stopFind", "findNext",
                                 "openDevTools", "inspectElement", "viewSource", "", "FIND"}) {
    CHECK(!policy::Handles(other));
  }
  CHECK(policy::IsZoomRoute("sites.zoomLevels") && policy::IsZoomRoute("sites.setZoom"));
  CHECK(!policy::IsZoomRoute("sites.settings") && !policy::IsZoomRoute("sites.setzoom"));
}

TEST(page_actions_and_devtools_panels) {
  CHECK(policy::PageActionFor("savePage") == policy::PageAction::kSavePage);
  CHECK(policy::PageActionFor("systemPrint") == policy::PageAction::kSystemPrint);
  CHECK(policy::PageActionFor("viewSource") == policy::PageAction::kViewSource);
  CHECK(policy::PageActionFor("caretBrowsing") == policy::PageAction::kUnsupported);
  CHECK(policy::PageActionFor("SavePage") == policy::PageAction::kUnsupported);
  CHECK(policy::DevToolsPanelFor(std::nullopt) == policy::DevToolsPanel::kShow);
  CHECK(policy::DevToolsPanelFor("toggle") == policy::DevToolsPanel::kToggle);
  CHECK(policy::DevToolsPanelFor("inspect") == policy::DevToolsPanel::kInspect);
  CHECK(policy::DevToolsPanelFor("console") == policy::DevToolsPanel::kConsole);
  CHECK(!policy::DevToolsPanelFor("show").has_value());
  CHECK(!policy::DevToolsPanelFor("").has_value());
}

TEST(whole_numbers_zoom_steps_and_offsets) {
  CHECK(policy::WholeNumber(3) == 3);
  CHECK(policy::WholeNumber(-2) == -2);
  CHECK(!policy::WholeNumber(1.5).has_value());
  CHECK(!policy::WholeNumber(std::numeric_limits<double>::quiet_NaN()).has_value());
  CHECK(!policy::WholeNumber(std::numeric_limits<double>::infinity()).has_value());
  CHECK(!policy::WholeNumber(1e20).has_value());
  CHECK(policy::ZoomStep(-1) == -1 && policy::ZoomStep(0) == 0 && policy::ZoomStep(1) == 1);
  CHECK(!policy::ZoomStep(2).has_value() && !policy::ZoomStep(0.5).has_value());
}

TEST(sleep_image_and_popup_arguments) {
  CHECK(policy::SleepSeconds(0) == 0.0);
  CHECK(policy::SleepSeconds(policy::kSleepLongestHiddenSeconds).has_value());
  CHECK(!policy::SleepSeconds(policy::kSleepLongestHiddenSeconds + 1).has_value());
  CHECK(!policy::SleepSeconds(-1).has_value());
  CHECK(!policy::SleepSeconds(std::numeric_limits<double>::quiet_NaN()).has_value());
  CHECK(policy::ImagePixels(1) == 1 && policy::ImagePixels(512) == 512);
  CHECK(!policy::ImagePixels(0).has_value() && !policy::ImagePixels(513).has_value());
  CHECK(policy::ImageScheme("https") && policy::ImageScheme("http") && policy::ImageScheme("data"));
  CHECK(!policy::ImageScheme("file") && !policy::ImageScheme("javascript") && !policy::ImageScheme("chrome"));
  CHECK(policy::PopupId("0") == 0 && policy::PopupId("2147483647") == 2147483647);
  CHECK(!policy::PopupId("2147483648").has_value());
  CHECK(!policy::PopupId("-1").has_value() && !policy::PopupId("").has_value());
  CHECK(!policy::PopupId("1e3").has_value() && !policy::PopupId("12345678901").has_value());
}

TEST(discard_and_freeze_follow_the_linux_protection_order) {
  const policy::Protection clear{false, false, false, false, false, false, false};
  CHECK(!policy::ProtectionReason(clear).has_value());
  CHECK(policy::MayFreeze(clear));
  policy::Protection visible = clear;
  visible.visible = true;
  CHECK(policy::ProtectionReason(visible) == "visible");
  policy::Protection unknown = clear;
  unknown.dirty_input.reset();
  CHECK(policy::ProtectionReason(unknown) == "unknown unsaved input");
  CHECK(!policy::MayFreeze(unknown));
  CHECK(policy::DecideDiscard(true, false, false, clear) == policy::DiscardDecision::kDiscard);
  CHECK(policy::DecideDiscard(true, false, true, clear) == policy::DiscardDecision::kUnsupported);
  CHECK(policy::DecideDiscard(false, false, false, clear) == policy::DiscardDecision::kRefused);
  CHECK(policy::DecideDiscard(true, true, false, visible) == policy::DiscardDecision::kAlready);
  CHECK(policy::DecideDiscard(true, false, false, visible) == policy::DiscardDecision::kRefused);
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kDiscard, true) == "discarded");
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kDiscard, false) == "refused");
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kAlready, false) == "already");
  CHECK(policy::DiscardOutcome(policy::DiscardDecision::kUnsupported, false) == "unsupported");
}

TEST(crashes_load_errors_and_theme_colors) {
  CHECK(!policy::RendererGone(policy::Termination::kNormal));
  CHECK(!policy::RendererGone(policy::Termination::kStillRunning));
  CHECK(policy::RendererGone(policy::Termination::kCrashed));
  CHECK(policy::CrashReason(policy::Termination::kAbnormal) == "abnormal");
  CHECK(policy::CrashReason(policy::Termination::kKilled) == "killed");
  CHECK(policy::CrashReason(policy::Termination::kCrashed) == "crashed");
  CHECK(policy::CrashReason(policy::Termination::kOom) == "oom");
  CHECK(policy::CrashReason(policy::Termination::kLaunchFailed) == "launchFailed");
  CHECK(policy::CrashReason(policy::Termination::kOther) == "unknown");
  CHECK(!policy::NavigationLoadError(0) && !policy::NavigationLoadError(-3));
  CHECK(policy::NavigationLoadError(-105) && policy::NavigationLoadError(-2));
  CHECK(policy::ThemeColorText(0, 0, 0) == "#000000");
  CHECK(policy::ThemeColorText(255, 16, 171) == "#ff10ab");
}

TEST(site_zoom_hosts_and_factors) {
  CHECK(policy::ZoomHostShape("example.com"));
  CHECK(policy::ZoomHostShape("[::1]"));
  CHECK(!policy::ZoomHostShape(""));
  CHECK(!policy::ZoomHostShape("example.com:8080"));
  CHECK(!policy::ZoomHostShape("a/b") && !policy::ZoomHostShape("a b") && !policy::ZoomHostShape("u@h"));
  CHECK(!policy::ZoomHostShape(std::string(254, 'a')));
  CHECK(policy::ZoomFactorAllowed(1) && policy::ZoomFactorAllowed(0.25) && policy::ZoomFactorAllowed(5));
  CHECK(!policy::ZoomFactorAllowed(0.2) && !policy::ZoomFactorAllowed(5.01));
  CHECK(!policy::ZoomFactorAllowed(std::numeric_limits<double>::quiet_NaN()));
  CHECK_NEAR(*policy::ReportedZoomFactor(1.10000001), 1.1);
  CHECK(!policy::ReportedZoomFactor(0.001).has_value());
}

TEST(evaluation_runs_only_known_operations) {
  const std::array<policy::Operation, 3> operations = {{
      {"plain", 9, "plainBody", policy::Arguments::kNone, ""},
      {"replace", 6, "swap((", policy::Arguments::kReplace, ")"},
      {"look", 5, "look(", policy::Arguments::kLook, ");"},
  }};
  const auto plain = policy::MatchOperation("plainBody", &Identity, operations);
  CHECK(plain && plain->operation->name == "plain" && plain->arguments.empty());
  CHECK(!policy::MatchOperation("plainBody;alert(1)", &Identity, operations).has_value());
  CHECK(!policy::MatchOperation("plainbody", &Identity, operations).has_value());
  const auto swap = policy::MatchOperation("swap((\"a\", \"b\", true)", &Identity, operations);
  CHECK(swap && swap->operation->name == "replace" && swap->arguments == "\"a\", \"b\", true");
  CHECK(!policy::MatchOperation("swap((", &Identity, operations).has_value());
  const auto loose = policy::MatchOperation("swap((x)alert(1)", &Identity, operations);
  CHECK(loose && loose->arguments == "x)alert(1");
  const auto look = policy::MatchOperation("look({});", &Identity, operations);
  CHECK(look && look->arguments == "{}");
  CHECK(!policy::MatchOperation("", &Identity, operations).has_value());
  CHECK(!policy::MatchOperation(std::string(policy::kEvaluationCodeMax + 1, 'p'), &Identity,
                                operations)
             .has_value());
}

TEST(evaluation_arguments_are_rebuilt_not_forwarded) {
  CHECK(policy::JavaScriptString("a\"b\\c") == "\"a\\\"b\\\\c\"");
  CHECK(policy::JavaScriptString("</script>") == "\"\\u003c/script\\u003e\"");
  CHECK(policy::JavaScriptString(std::string("\n\x7f", 2)) == "\"\\u000a\\u007f\"");
  CHECK(policy::JavaScriptString("\xe2\x80\xa8\xe2\x80\xa9") == "\"\\u2028\\u2029\"");
  CHECK(policy::ReplaceArguments("a", "b", true) == "\"a\", \"b\", true");
  CHECK(!policy::ReplaceArguments(std::string(policy::kReplaceTextMax + 1, 'a'), "b", false).has_value());
  CHECK(!policy::ReplaceArguments(std::string("a\0b", 3), "b", false).has_value());
  CHECK(policy::LookArgument(true, 2, "serif", 5, kFonts) ==
        "{\"dark\":true,\"size\":2,\"font\":\"serif\"}");
  CHECK(!policy::LookArgument(false, 5, "serif", 5, kFonts).has_value());
  CHECK(!policy::LookArgument(false, -1, "serif", 5, kFonts).has_value());
  CHECK(!policy::LookArgument(false, 1, "\"};alert(1)", 5, kFonts).has_value());
  CHECK(policy::PickerPoint(std::nullopt, std::nullopt) == "null");
  CHECK(policy::PickerPoint(1.5, -2) == "[1.5,-2]");
  CHECK(!policy::PickerPoint(1, std::nullopt).has_value());
  CHECK(!policy::PickerPoint(2e6, 0).has_value());
  CHECK(!policy::PickerPoint(std::numeric_limits<double>::quiet_NaN(), 0).has_value());
  const std::vector<std::string_view> selectors = {"a.b", "#c"};
  CHECK(policy::PickerSelectors(selectors) == "[\"a.b\",\"#c\"]");
  const std::vector<std::string_view> empty_selector = {""};
  CHECK(!policy::PickerSelectors(empty_selector).has_value());
  const std::vector<std::string_view> too_many(policy::kPickerSelectorsMax + 1, "a");
  CHECK(!policy::PickerSelectors(too_many).has_value());
  const std::string wrapped = policy::WrapEvaluation("post(\"result\", \"1\")");
  CHECK(wrapped.starts_with("(() => {\nlet ardiaResult = null;\n"));
  CHECK(wrapped.find("try {\npost(\"result\", \"1\")\n;\n} catch (ardiaError) {}") != std::string::npos);
  CHECK(wrapped.ends_with("return ardiaResult;\n})()"));
  CHECK(policy::EvaluationResultFits(policy::kEvaluationResultMax));
  CHECK(!policy::EvaluationResultFits(policy::kEvaluationResultMax + 1));
  CHECK(policy::ScriptableScheme("https") && policy::ScriptableScheme("file"));
  CHECK(!policy::ScriptableScheme("chrome") && !policy::ScriptableScheme("devtools"));
  CHECK(policy::FindTextFits(policy::kFindTextMax) && !policy::FindTextFits(policy::kFindTextMax + 1));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
