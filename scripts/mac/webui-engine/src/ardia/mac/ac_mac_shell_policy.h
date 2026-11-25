#ifndef ARDIA_MAC_AC_MAC_SHELL_POLICY_H_
#define ARDIA_MAC_AC_MAC_SHELL_POLICY_H_

#include <algorithm>
#include <cstddef>
#include <string_view>

namespace ardia_mac::shell_policy {

inline constexpr std::size_t kSessionLimit = 64 * 1024 * 1024;
inline constexpr std::size_t kDocumentNameLimit = 200;
inline constexpr std::string_view kSessionFile = "session.json";

inline char LowerAscii(char c) {
  return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c;
}

inline bool EqualsIgnoringAsciiCase(std::string_view a, std::string_view b) {
  return a.size() == b.size() &&
         std::equal(a.begin(), a.end(), b.begin(), [](char x, char y) { return LowerAscii(x) == LowerAscii(y); });
}

inline bool ValidDocumentName(std::string_view name) {
  if (name.empty() || name.size() > kDocumentNameLimit || name.front() == '.') return false;
  const bool charset = std::all_of(name.begin(), name.end(), [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' ||
           c == '-';
  });
  return charset && !EqualsIgnoringAsciiCase(name, kSessionFile);
}

inline bool SessionFits(std::size_t serialized_bytes) {
  return serialized_bytes <= kSessionLimit;
}

enum class TabRequest { kCreate, kReclaim, kReplace };

inline TabRequest RequestFor(bool key_bound, bool same_profile) {
  if (!key_bound) return TabRequest::kCreate;
  return same_profile ? TabRequest::kReclaim : TabRequest::kReplace;
}

struct Replacement {
  bool keep_old_binding = true;
  bool close_old_tab = false;
  bool bind_new = false;
  bool succeeded = false;
};

inline Replacement AfterReplacement(bool replacement_opened, bool old_tab_closable) {
  if (!replacement_opened) return Replacement{true, false, false, false};
  if (!old_tab_closable) return Replacement{true, false, true, true};
  return Replacement{false, true, true, true};
}

}

#endif
