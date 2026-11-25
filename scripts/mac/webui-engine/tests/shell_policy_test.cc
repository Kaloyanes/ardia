#include "ardia/mac/ac_mac_shell_policy.h"

#include <string>

#include "check.h"

namespace policy = ardia_mac::shell_policy;

TEST(session_json_is_reserved_in_every_ascii_case) {
  for (const char* name : {"session.json", "Session.json", "SESSION.JSON", "sEsSiOn.JsOn", "session.JSON"}) {
    CHECK(!policy::ValidDocumentName(name));
  }
  CHECK(policy::ValidDocumentName("sessions.json"));
  CHECK(policy::ValidDocumentName("session.json.bak"));
  CHECK(policy::ValidDocumentName("notes.json"));
}

TEST(document_names_keep_their_charset) {
  CHECK(!policy::ValidDocumentName(""));
  CHECK(!policy::ValidDocumentName(".hidden"));
  CHECK(!policy::ValidDocumentName("a/b.json"));
  CHECK(!policy::ValidDocumentName("..json/x"));
  CHECK(!policy::ValidDocumentName(std::string(201, 'a')));
  CHECK(policy::ValidDocumentName(std::string(200, 'a')));
}

TEST(oversized_sessions_are_refused_before_writing) {
  CHECK(policy::SessionFits(0));
  CHECK(policy::SessionFits(policy::kSessionLimit));
  CHECK(!policy::SessionFits(policy::kSessionLimit + 1));
  CHECK(policy::kSessionLimit == 64u * 1024u * 1024u);
}

TEST(default_profile_offers_use_the_empty_engine_name) {
  CHECK(policy::OfferedProfile("default").empty());
  CHECK(policy::OfferedProfile("work") == "work");
  CHECK(policy::OfferedProfile("").empty());
}

TEST(adopt_field_shapes) {
  using policy::AdoptField;
  CHECK(policy::ClassifyAdoptField(false, false, "") == AdoptField::kAbsent);
  CHECK(policy::ClassifyAdoptField(true, false, "") == AdoptField::kInvalid);
  CHECK(policy::ClassifyAdoptField(true, true, "") == AdoptField::kInvalid);
  CHECK(policy::ClassifyAdoptField(true, true, "tab:x") == AdoptField::kInvalid);
  CHECK(policy::ClassifyAdoptField(true, true, "tab:7") == AdoptField::kId);
}

TEST(create_plans_check_the_adopt_id_before_reclaim_or_create) {
  using policy::AdoptField;
  using policy::AdoptRefusal;
  using policy::CreatePlan;
  policy::CreateRequest fresh;
  CHECK(policy::PlanCreate(fresh) == CreatePlan::kCreate);
  policy::CreateRequest non_string = fresh;
  non_string.adopt = AdoptField::kInvalid;
  CHECK(policy::PlanCreate(non_string) == CreatePlan::kRefuse);
  policy::CreateRequest reclaim{AdoptField::kAbsent, 0, true, true, 9, AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(reclaim) == CreatePlan::kReclaim);
  policy::CreateRequest invalid_on_existing = reclaim;
  invalid_on_existing.adopt = AdoptField::kInvalid;
  CHECK(policy::PlanCreate(invalid_on_existing) == CreatePlan::kRefuse);
  policy::CreateRequest mismatched = reclaim;
  mismatched.adopt = AdoptField::kId;
  mismatched.adopt_id = 4;
  CHECK(policy::PlanCreate(mismatched) == CreatePlan::kRefuse);
  policy::CreateRequest matching = mismatched;
  matching.adopt_id = 9;
  CHECK(policy::PlanCreate(matching) == CreatePlan::kReclaim);
  policy::CreateRequest adopt{AdoptField::kId, 4, false, false, 0, AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(adopt) == CreatePlan::kAdopt);
  adopt.adoption = AdoptRefusal::kNotOffered;
  CHECK(policy::PlanCreate(adopt) == CreatePlan::kRefuse);
  policy::CreateRequest move{AdoptField::kAbsent, 0, true, false, 9, AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(move) == CreatePlan::kReplace);
  policy::CreateRequest adopt_move{AdoptField::kId, 4, true, false, 9, AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(adopt_move) == CreatePlan::kAdoptReplacing);
}

TEST(a_cross_profile_move_is_always_replaced) {
  policy::CreateRequest move{policy::AdoptField::kAbsent, 0, true, false, 9, policy::AdoptRefusal::kNone};
  CHECK(policy::PlanCreate(move) == policy::CreatePlan::kReplace);
}

TEST(offers_keep_their_active_disposition_and_leave_with_their_tab) {
  policy::OfferBook<int> book;
  book.Add(3, 30, true);
  book.Add(4, 40, false);
  CHECK(book.Find(3) && book.Find(3)->active && book.Find(3)->handle == 30);
  CHECK(book.Find(4) && !book.Find(4)->active);
  book.Forget(3);
  CHECK(!book.Find(3) && book.size() == 1);
  book.Add(5, 0, true);
  book.Prune([](int, const auto& offer) { return offer.handle != 0; });
  CHECK(book.size() == 1 && book.Find(4));
  for (int id = 0; id < 1000; ++id) {
    book.Add(100 + id, id + 1, id % 2 == 0);
    book.Forget(100 + id);
  }
  CHECK(book.size() == 1);
}

TEST(suppressed_shortcuts_are_consumed_without_a_command) {
  CHECK(policy::ShortcutActionFor(true) == policy::ShortcutAction::kConsume);
  CHECK(policy::ShortcutActionFor(false) == policy::ShortcutAction::kDispatch);
  CHECK(policy::ShortcutAccepted(84, 0, false, true));
  CHECK(policy::ShortcutAccepted(84, 4, true, false));
  CHECK(!policy::ShortcutAccepted(84, 0, false, false));
  CHECK(!policy::ShortcutAccepted(0, 0, true, false));
  CHECK(!policy::ShortcutAccepted(300, 0, true, true));
  CHECK(!policy::ShortcutAccepted(84, -1, true, true));
}

TEST(adopt_ids_are_tab_and_a_positive_int) {
  CHECK(policy::ParseAdoptId("tab:1") == 1);
  CHECK(policy::ParseAdoptId("tab:2147483647") == 2147483647);
  for (const char* bad : {"", "tab:", "tab:0", "tab:-1", "tab:2147483648", "tab:12a", "tab: 1", "ardiacore:1",
                          "TAB:1", "tab:99999999999", "tab:1\n"}) {
    CHECK(!policy::ParseAdoptId(bad));
  }
}

TEST(unclaimed_tabs_are_offered_once_the_shell_listens) {
  using policy::UnclaimedStep;
  CHECK(policy::NextUnclaimedStep(true, true, true, false, 0) == UnclaimedStep::kDrop);
  CHECK(policy::NextUnclaimedStep(false, false, true, false, 0) == UnclaimedStep::kWait);
  CHECK(policy::NextUnclaimedStep(false, false, true, false, policy::kUnclaimedTries) == UnclaimedStep::kDrop);
  CHECK(policy::NextUnclaimedStep(true, false, false, false, 0) == UnclaimedStep::kPark);
  CHECK(policy::NextUnclaimedStep(true, false, true, true, 0) == UnclaimedStep::kWait);
  CHECK(policy::NextUnclaimedStep(true, false, true, true, policy::kUnclaimedTries) == UnclaimedStep::kReport);
  CHECK(policy::NextUnclaimedStep(true, false, true, false, 0) == UnclaimedStep::kReport);
}

TEST(only_an_offered_unbound_tab_of_the_same_profile_is_adopted) {
  using policy::AdoptRefusal;
  CHECK(policy::CheckAdoption(true, true, true, true, false) == AdoptRefusal::kNone);
  CHECK(policy::CheckAdoption(false, true, true, true, false) == AdoptRefusal::kMalformed);
  CHECK(policy::CheckAdoption(true, false, true, true, false) == AdoptRefusal::kNotOffered);
  CHECK(policy::CheckAdoption(true, true, false, true, false) == AdoptRefusal::kOtherProfile);
  CHECK(policy::CheckAdoption(true, true, true, false, false) == AdoptRefusal::kGone);
  CHECK(policy::CheckAdoption(true, true, true, true, true) == AdoptRefusal::kAlreadyClaimed);
}

TEST(shortcuts_take_only_chromium_key_modifiers) {
  CHECK(policy::kCommandDown == 16 && policy::kControlDown == 4 && policy::kAltDown == 8 && policy::kShiftDown == 2);
  CHECK(policy::ShortcutAccepted(84, policy::kCommandDown, true, false));
  CHECK(policy::ShortcutAccepted(9, policy::kControlDown | policy::kShiftDown, true, false));
  CHECK(policy::ShortcutAccepted(83, policy::kCommandDown | policy::kAltDown | policy::kControlDown | policy::kShiftDown, true, false));
  CHECK(!policy::ShortcutAccepted(84, 1 << 5, true, false));
  CHECK(!policy::ShortcutAccepted(84, policy::kCommandDown | 1, true, false));
  CHECK(!policy::ShortcutAccepted(84, -1, true, false));
  CHECK(!policy::ShortcutAccepted(0, policy::kCommandDown, true, false));
  CHECK(!policy::ShortcutAccepted(256, policy::kCommandDown, true, false));
  CHECK(!policy::ShortcutAccepted(84, policy::kCommandDown, false, false));
  CHECK(policy::ShortcutAccepted(84, policy::kCommandDown, false, true));
}

TEST(shortcuts_run_before_the_page_unless_a_text_field_may_take_them) {
  CHECK(policy::ShortcutTimingFor(false) == policy::ShortcutTiming::kBeforePage);
  CHECK(policy::ShortcutTimingFor(true) == policy::ShortcutTiming::kAfterPage);
}

TEST(window_requests_keep_utility_ids_to_their_kind) {
  using policy::WindowRefusal;
  CHECK(policy::CheckWindowRequest({"settings", "settings", "", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"import", "import", "", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"w-1f2e", "", "", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"w-1f2e", "small", "work", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"w-1f2e", "browser", "default", false, false}) == WindowRefusal::kNone);
  CHECK(policy::CheckWindowRequest({"other", "settings", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({"settings", "browser", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({"import", "", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({"", "", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({std::string(257, 'a'), "", "", false, false}) == WindowRefusal::kInvalid);
  CHECK(policy::CheckWindowRequest({std::string(256, 'a'), "", "", false, false}) == WindowRefusal::kNone);
  for (const char* hostile : {"../main", "a b", "w\n", "w/1", "<script>", "w%"}) {
    CHECK(policy::CheckWindowRequest({hostile, "", "", false, false}) == WindowRefusal::kInvalid);
  }
}

TEST(private_windows_and_bad_profiles_are_refused_before_a_window_opens) {
  using policy::WindowRefusal;
  CHECK(policy::CheckWindowRequest({"p-1", "", "", true, false}) == WindowRefusal::kPrivateUnavailable);
  CHECK(policy::CheckWindowRequest({"p-1", "", "", false, true}) == WindowRefusal::kPrivateUnavailable);
  CHECK(policy::CheckWindowRequest({"w-1", "", "../Default", false, false}) == WindowRefusal::kProfile);
  CHECK(policy::CheckWindowRequest({"w-1", "", "1work", false, false}) == WindowRefusal::kProfile);
  CHECK(policy::CheckWindowRequest({"w-1", "", "incognito:w@default", false, false}) == WindowRefusal::kProfile);
  CHECK(policy::ValidProfileId("work_2-b"));
  CHECK(!policy::ValidProfileId(""));
  CHECK(!policy::ValidProfileId(std::string(129, 'a')));
}

TEST(windows_open_as_their_kind_with_the_page_profile_they_name) {
  CHECK(policy::WindowKindFor("settings") == "settings");
  CHECK(policy::WindowKindFor("import") == "import");
  CHECK(policy::WindowKindFor("small") == "small");
  CHECK(policy::WindowKindFor("") == "browser");
  CHECK(policy::WindowKindFor("popup") == "browser");
  CHECK(policy::PageProfileFor("browser", "work") == "work");
  CHECK(policy::PageProfileFor("browser", "default").empty());
  CHECK(policy::PageProfileFor("settings", "work").empty());
  CHECK(policy::PageProfileFor("", "").empty());
}

TEST(closing_a_window_closes_that_window_and_only_the_last_browser_window_quits) {
  using policy::CloseAction;
  CHECK(policy::CloseActionFor(false, false, 2) == CloseAction::kRefuse);
  CHECK(policy::CloseActionFor(true, true, 1) == CloseAction::kCloseWindow);
  CHECK(policy::CloseActionFor(true, true, 0) == CloseAction::kCloseWindow);
  CHECK(policy::CloseActionFor(true, false, 2) == CloseAction::kCloseWindow);
  CHECK(policy::CloseActionFor(true, false, 1) == CloseAction::kQuit);
}

TEST(recording_a_shortcut_lets_every_key_reach_the_recorder) {
  CHECK(policy::AcceleratorsLive(true, true, false));
  CHECK(!policy::AcceleratorsLive(true, true, true));
  CHECK(!policy::AcceleratorsLive(false, true, false));
  CHECK(!policy::AcceleratorsLive(true, false, false));
}

TEST(close_generations_are_positive_decimal_strings) {
  CHECK(policy::ParseGeneration("1") == 1u);
  CHECK(policy::ParseGeneration("18446744073709551615") == 18446744073709551615u);
  for (const char* bad : {"", "0", "01", "-1", "1.0", "1e3", " 1", "18446744073709551616", "999999999999999999999"}) {
    CHECK(!policy::ParseGeneration(bad));
  }
}

TEST(a_close_request_drains_seals_and_only_its_own_identity_moves_it) {
  policy::CloseLedger ledger;
  CHECK(!ledger.Request(0));
  const auto first = ledger.Request(4);
  CHECK(first && first->renderer == 4 && first->close == 1);
  CHECK(ledger.phase() == policy::CloseLedger::Phase::kRequested);
  CHECK(ledger.Request(4) == first);
  CHECK(!ledger.BeginDrain({4, 2}, 4));
  CHECK(!ledger.BeginDrain(*first, 5));
  CHECK(!ledger.Seal(*first, 4));
  CHECK(ledger.BeginDrain(*first, 4));
  CHECK(!ledger.BlocksWrites());
  CHECK(ledger.Seal(*first, 4));
  CHECK(ledger.BlocksWrites());
  CHECK(!ledger.Cancel(*first, 4));
  CHECK(!ledger.Request(4));
  ledger.RendererRetired();
  CHECK(ledger.BlocksWrites());
  CHECK(ledger.Commits(*first));
  CHECK(ledger.Reopen(*first, 5));
  CHECK(ledger.phase() == policy::CloseLedger::Phase::kIdle);
  CHECK(!ledger.Commits(*first));
}

TEST(a_rejected_close_frees_the_window_and_the_next_request_is_new) {
  policy::CloseLedger ledger;
  const auto first = ledger.Request(2);
  CHECK(ledger.Cancel(*first, 2));
  CHECK(ledger.phase() == policy::CloseLedger::Phase::kIdle);
  CHECK(!ledger.Cancel(*first, 2));
  CHECK(!ledger.BeginDrain(*first, 2));
  const auto second = ledger.Request(2);
  CHECK(second && second->close == 2);
  ledger.RendererRetired();
  CHECK(ledger.phase() == policy::CloseLedger::Phase::kIdle);
  const auto reloaded = ledger.Request(3);
  CHECK(reloaded && reloaded->renderer == 3 && reloaded->close == 3);
  CHECK(!ledger.BeginDrain(*second, 3));
}

TEST(a_failed_departure_reopens_the_drain_and_a_vetoed_teardown_unseals) {
  policy::CloseLedger ledger;
  const auto identity = *ledger.Request(6);
  CHECK(ledger.BeginDrain(identity, 6) && ledger.Seal(identity, 6));
  CHECK(!ledger.Reopen(policy::CloseIdentity{6, 99}, 6));
  CHECK(ledger.Reopen(identity, 6));
  CHECK(!ledger.BlocksWrites() && ledger.Leaving());
  CHECK(ledger.Cancel(identity, 6));
  const auto next = *ledger.Request(6);
  CHECK(ledger.BeginDrain(next, 6) && ledger.Seal(next, 6));
  CHECK(ledger.Unseal() == next);
  CHECK(!ledger.BlocksWrites() && !ledger.Leaving());
  CHECK(!ledger.Unseal());
  CHECK(ledger.Request(6)->close == next.close + 1);
}

TEST(only_the_last_staying_browser_window_ends_the_session) {
  CHECK(policy::EndsSessionFor(false, 0));
  CHECK(!policy::EndsSessionFor(false, 1));
  CHECK(!policy::EndsSessionFor(true, 0));
  policy::CloseLedger first;
  policy::CloseLedger second;
  const auto a = *first.Request(1);
  const auto b = *second.Request(1);
  CHECK(first.BeginDrain(a, 1));
  const bool first_ends = policy::EndsSessionFor(false, second.Leaving() ? 0 : 1);
  CHECK(second.BeginDrain(b, 1));
  const bool second_ends = policy::EndsSessionFor(false, first.Leaving() ? 0 : 1);
  CHECK(!first_ends && second_ends);
}

TEST(the_final_window_waits_for_a_draining_peer_and_never_quits_ahead_of_it) {
  using policy::FinalStep;
  CHECK(policy::FinalStepFor(false, true, 0, 1) == FinalStep::kWaitForPeers);
  CHECK(policy::FinalStepFor(false, true, 0, 0) == FinalStep::kQuit);
  CHECK(policy::FinalStepFor(false, false, 0, 1) == FinalStep::kCloseWindow);
  CHECK(policy::FinalStepFor(true, true, 0, 0) == FinalStep::kCloseWindow);
}

TEST(when_a_peer_stays_after_all_the_final_window_closes_again_with_its_departure) {
  using policy::FinalStep;
  CHECK(policy::FinalStepFor(false, true, 1, 0) == FinalStep::kCloseAgainWithDeparture);
  CHECK(policy::FinalStepFor(false, true, 1, 1) == FinalStep::kCloseAgainWithDeparture);
  policy::CloseLedger a;
  policy::CloseLedger b;
  const auto first = *a.Request(1);
  const auto second = *b.Request(1);
  CHECK(a.BeginDrain(first, 1));
  CHECK(b.BeginDrain(second, 1) && b.Seal(second, 1));
  CHECK(policy::FinalStepFor(false, true, a.Leaving() ? 0 : 1, a.Leaving() ? 1 : 0) == FinalStep::kWaitForPeers);
  CHECK(a.Cancel(first, 1));
  CHECK(policy::FinalStepFor(false, true, a.Leaving() ? 0 : 1, a.Leaving() ? 1 : 0) == FinalStep::kCloseAgainWithDeparture);
  CHECK(b.Unseal() == second);
  const auto again = *b.Request(1);
  CHECK(again.close == second.close + 1);
  CHECK(!policy::EndsSessionFor(false, a.Leaving() ? 0 : 1));
}

TEST(when_the_peer_finishes_first_the_final_window_then_quits) {
  policy::CloseLedger b;
  const auto second = *b.Request(1);
  CHECK(b.BeginDrain(second, 1) && b.Seal(second, 1));
  CHECK(policy::FinalStepFor(false, true, 0, 1) == policy::FinalStep::kWaitForPeers);
  CHECK(b.Commits(second));
  CHECK(policy::FinalStepFor(false, true, 0, 0) == policy::FinalStep::kQuit);
}

TEST(every_page_must_agree_before_a_close_commits) {
  using Outcome = policy::UnloadRound::Outcome;
  policy::UnloadRound round(2);
  CHECK(round.Answer(true) == Outcome::kWaiting);
  CHECK(round.Answer(true) == Outcome::kProceed);
  CHECK(round.Answer(false) == Outcome::kProceed);
  policy::UnloadRound stay(3);
  CHECK(stay.Answer(true) == Outcome::kWaiting);
  CHECK(stay.Answer(false) == Outcome::kStay);
  CHECK(stay.Answer(true) == Outcome::kStay);
}

TEST(an_already_cancelled_close_rejects_cleanly) {
  policy::CloseLedger ledger;
  const auto identity = *ledger.Request(2);
  CHECK(!ledger.AlreadyCancelled(identity));
  CHECK(ledger.BeginDrain(identity, 2) && ledger.Seal(identity, 2));
  CHECK(ledger.Unseal() == identity);
  CHECK(ledger.AlreadyCancelled(identity));
  CHECK(!ledger.AlreadyCancelled(policy::CloseIdentity{2, identity.close + 1}));
  CHECK(!policy::CloseLedger().AlreadyCancelled(policy::CloseIdentity{}));
}

TEST(only_a_refused_teardown_counts_as_cancelled) {
  CHECK(policy::CloseCancelledFor(true, false, false));
  CHECK(policy::CloseCancelledFor(false, true, false));
  CHECK(!policy::CloseCancelledFor(false, false, true));
  CHECK(!policy::CloseCancelledFor(true, false, true));
  CHECK(!policy::CloseCancelledFor(false, false, false));
}

TEST(recording_sends_this_windows_key_equivalents_to_the_shell) {
  using policy::RecordingRoute;
  CHECK(policy::RecordingRouteFor(true, true, true) == RecordingRoute::kToShell);
  CHECK(policy::RecordingRouteFor(false, true, true) == RecordingRoute::kNormal);
  CHECK(policy::RecordingRouteFor(true, false, true) == RecordingRoute::kNormal);
  CHECK(policy::RecordingRouteFor(true, true, false) == RecordingRoute::kNormal);
}

TEST(a_session_on_disk_the_merge_cannot_take_is_set_aside_not_wedged) {
  using policy::SessionFile;
  CHECK(policy::SessionFileFor(false, 0, false, false) == SessionFile::kAbsent);
  CHECK(policy::SessionFileFor(true, 1024, true, true) == SessionFile::kUse);
  CHECK(policy::SessionFileFor(true, policy::kMergeableSessionBytes, true, true) == SessionFile::kUse);
  CHECK(policy::SessionFileFor(true, policy::kMergeableSessionBytes + 1, false, false) == SessionFile::kSetAside);
  CHECK(policy::SessionFileFor(true, 64u * 1024u * 1024u + 1, false, false) == SessionFile::kSetAside);
  CHECK(policy::SessionFileFor(true, 4096, true, false) == SessionFile::kSetAside);
  CHECK(policy::SessionFileFor(true, 4096, false, false) == SessionFile::kSetAside);
  const std::string name = policy::SetAsideSessionName(1795642159057u);
  CHECK(name == "session-backup-oversized-1795642159057.json");
  CHECK(policy::ValidDocumentName(name));
  CHECK(name.starts_with("session-backup"));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
