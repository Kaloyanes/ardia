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
  policy::CreateRequest reclaim{AdoptField::kAbsent, 0, true, true, 9, AdoptRefusal::kNone, false};
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
  policy::CreateRequest adopt{AdoptField::kId, 4, false, false, 0, AdoptRefusal::kNone, false};
  CHECK(policy::PlanCreate(adopt) == CreatePlan::kAdopt);
  adopt.adoption = AdoptRefusal::kNotOffered;
  CHECK(policy::PlanCreate(adopt) == CreatePlan::kRefuse);
  policy::CreateRequest move{AdoptField::kAbsent, 0, true, false, 9, AdoptRefusal::kNone, false};
  CHECK(policy::PlanCreate(move) == CreatePlan::kReplace);
  policy::CreateRequest adopt_move{AdoptField::kId, 4, true, false, 9, AdoptRefusal::kNone, false};
  CHECK(policy::PlanCreate(adopt_move) == CreatePlan::kAdoptReplacing);
}

TEST(a_cross_profile_move_waits_for_a_tab_with_unload_handlers) {
  using policy::CreatePlan;
  policy::CreateRequest guarded{policy::AdoptField::kAbsent, 0, true, false, 9, policy::AdoptRefusal::kNone, true};
  CHECK(policy::PlanCreate(guarded) == CreatePlan::kRefuse);
  guarded.same_profile = true;
  CHECK(policy::PlanCreate(guarded) == CreatePlan::kReclaim);
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

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
