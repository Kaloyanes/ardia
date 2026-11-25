#ifndef ARDIA_DESKTOP_AC_DESKTOP_WEBUI_PROCESS_POLICY_H_
#define ARDIA_DESKTOP_AC_DESKTOP_WEBUI_PROCESS_POLICY_H_

#include <cstddef>
#include <deque>
#include <string_view>

namespace ardia::desktop_webui_process {

inline constexpr std::string_view kShellScheme = "chrome";
inline constexpr std::string_view kShellHost = "ardia";
inline constexpr char kShellUrl[] = "chrome://ardia/";

struct Principal {
  bool has_profile = false;
  bool off_the_record = false;
  bool scheme_is_shell = false;
  std::string_view host;
  std::string_view site;
  bool webui = false;
  bool guest = false;
  bool sandboxed = false;
};

inline constexpr bool SharesShellProcess(const Principal& principal) {
  return principal.has_profile && !principal.off_the_record && principal.scheme_is_shell &&
         principal.host == kShellHost && principal.site == std::string_view(kShellUrl) && principal.webui &&
         !principal.guest && !principal.sandboxed;
}

inline constexpr size_t kShellReloadsAllowed = 3;
inline constexpr double kShellReloadWindowSeconds = 60;

class ShellReloadBudget {
 public:
  bool Allow(double now_seconds, bool normal_exit) {
    if (normal_exit) return false;
    while (!reloads_.empty() && now_seconds - reloads_.front() >= kShellReloadWindowSeconds) reloads_.pop_front();
    if (reloads_.size() >= kShellReloadsAllowed) return false;
    reloads_.push_back(now_seconds);
    return true;
  }

  size_t recent() const { return reloads_.size(); }

 private:
  std::deque<double> reloads_;
};

}

#endif
