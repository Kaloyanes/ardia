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

TEST(cross_profile_replacement_keeps_the_old_binding_until_the_new_tab_exists) {
  CHECK(policy::RequestFor(false, false) == policy::TabRequest::kCreate);
  CHECK(policy::RequestFor(true, true) == policy::TabRequest::kReclaim);
  CHECK(policy::RequestFor(true, false) == policy::TabRequest::kReplace);
  const auto failed = policy::AfterReplacement(false, true);
  CHECK(failed.keep_old_binding && !failed.close_old_tab && !failed.bind_new && !failed.succeeded);
  const auto replaced = policy::AfterReplacement(true, true);
  CHECK(!replaced.keep_old_binding && replaced.close_old_tab && replaced.bind_new && replaced.succeeded);
  const auto stuck = policy::AfterReplacement(true, false);
  CHECK(stuck.keep_old_binding && !stuck.close_old_tab && stuck.bind_new && stuck.succeeded);
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
