#ifndef ARDIA_DESKTOP_AC_DESKTOP_WEBUI_PROCESS_POLICY_H_
#define ARDIA_DESKTOP_AC_DESKTOP_WEBUI_PROCESS_POLICY_H_

#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string_view>

namespace ardia::desktop_webui_process {

inline constexpr std::string_view kShellScheme = "chrome";
inline constexpr std::string_view kShellHost = "ardia";
inline constexpr char kShellUrl[] = "chrome://ardia/";

inline constexpr int32_t kSharedShellRendererFeature = 0x41726469;

struct ShellWindow {
  bool private_window = false;
  bool off_the_record_profile = false;
};

inline constexpr std::optional<int32_t> SharedRendererFeature(const ShellWindow& window) {
  if (window.private_window || window.off_the_record_profile) return std::nullopt;
  return kSharedShellRendererFeature;
}

inline constexpr size_t kShellReloadsAllowed = 3;
inline constexpr double kShellReloadWindowSeconds = 60;

class ShellReloadBudget {
 public:
  bool Allow(double now_seconds) {
    while (!reloads_.empty() && now_seconds - reloads_.front() >= kShellReloadWindowSeconds) reloads_.pop_front();
    if (reloads_.size() >= kShellReloadsAllowed) return false;
    reloads_.push_back(now_seconds);
    return true;
  }

  size_t recent() const { return reloads_.size(); }

 private:
  std::deque<double> reloads_;
};

enum class WindowState { kOpen, kClosingReversibly, kGone };

enum class RecoveryStep { kNothing, kWaitForClose, kReloadDocument, kLoadShellUrl };

class ShellRecoveryState {
 public:
  void RendererGone(bool normal_exit) {
    if (!normal_exit) owed_ = true;
  }

  void DocumentCommitted() { owed_ = false; }

  RecoveryStep Next(double now_seconds, WindowState window, bool committed_shell_document) {
    if (!owed_) return RecoveryStep::kNothing;
    if (window == WindowState::kClosingReversibly) return RecoveryStep::kWaitForClose;
    owed_ = false;
    if (window == WindowState::kGone || !budget_.Allow(now_seconds)) return RecoveryStep::kNothing;
    return committed_shell_document ? RecoveryStep::kReloadDocument : RecoveryStep::kLoadShellUrl;
  }

  bool owed() const { return owed_; }
  size_t recent_reloads() const { return budget_.recent(); }

 private:
  bool owed_ = false;
  ShellReloadBudget budget_;
};

}

#endif
