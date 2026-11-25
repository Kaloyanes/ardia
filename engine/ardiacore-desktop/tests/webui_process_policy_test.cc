#include "ardia/desktop/ac_desktop_webui_process_policy.h"

#include <cassert>
#include <cstdio>
#include <string>
#include <string_view>

namespace {

namespace policy = ardia::desktop_webui_process;

struct Site {
  std::string_view scheme;
  std::string_view host;
  std::string_view site;
  bool webui;
};

policy::Principal ShellPrincipal() {
  return {
      .has_profile = true,
      .off_the_record = false,
      .scheme_is_shell = true,
      .host = policy::kShellHost,
      .site = policy::kShellUrl,
      .webui = true,
      .guest = false,
      .sandboxed = false,
  };
}

policy::Principal PrincipalFor(const Site& site) {
  policy::Principal principal = ShellPrincipal();
  principal.scheme_is_shell = site.scheme == policy::kShellScheme;
  principal.host = site.host;
  principal.site = site.site;
  principal.webui = site.webui;
  return principal;
}

void TestOnlyTheShellSiteShares() {
  assert(policy::SharesShellProcess(ShellPrincipal()));
  assert(std::string_view(policy::kShellUrl) == "chrome://ardia/");
  assert(policy::kShellScheme == "chrome");
  assert(policy::kShellHost == "ardia");

  const Site refused[] = {
      {"https", "ardia", "https://ardia/", false},
      {"https", "ardia.dev", "https://ardia.dev/", false},
      {"http", "ardia", "http://ardia/", false},
      {"chrome", "settings", "chrome://settings/", true},
      {"chrome", "newtab", "chrome://newtab/", true},
      {"chrome", "extensions", "chrome://extensions/", true},
      {"chrome", "ardia-settings", "chrome://ardia-settings/", true},
      {"chrome", "ardia.evil", "chrome://ardia.evil/", true},
      {"chrome", "xardia", "chrome://xardia/", true},
      {"chrome", "ARDIA", "chrome://ARDIA/", true},
      {"chrome", "ardia", "chrome://ardia", true},
      {"chrome", "ardia", "chrome://ardia/page", true},
      {"chrome", "ardia", "chrome://ardia:1/", true},
      {"chrome", "ardia", "chrome://user@ardia/", true},
      {"chrome", "ardia", "chrome://ardia/?x", true},
      {"chrome", "ardia", "chrome://ardia/#x", true},
      {"chrome", "", "chrome:///", true},
      {"chrome", "ardia", "", true},
      {"chrome", "", "", true},
      {"chrome-untrusted", "ardia", "chrome-untrusted://ardia/", true},
      {"chrome-extension", "ardia", "chrome-extension://ardia/", false},
      {"chrome-extension", "abcdefghijklmnopabcdefghijklmnop",
       "chrome-extension://abcdefghijklmnopabcdefghijklmnop/", false},
      {"devtools", "ardia", "devtools://ardia/", true},
      {"chrome-search", "ardia", "chrome-search://ardia/", true},
      {"file", "", "file:///", false},
      {"data", "", "data:", false},
      {"blob", "ardia", "blob:chrome://ardia/", false},
      {"filesystem", "ardia", "filesystem:chrome://ardia/", false},
      {"javascript", "", "javascript:", false},
      {"about", "", "about:blank", false},
      {"view-source", "ardia", "view-source:chrome://ardia/", false},
  };
  for (const Site& site : refused) {
    assert(!policy::SharesShellProcess(PrincipalFor(site)));
  }

  const std::string nul_host("ardia\0", 6);
  policy::Principal hostile = ShellPrincipal();
  hostile.host = nul_host;
  assert(!policy::SharesShellProcess(hostile));
  const std::string nul_site("chrome://ardia/\0", 16);
  hostile = ShellPrincipal();
  hostile.site = nul_site;
  assert(!policy::SharesShellProcess(hostile));

  hostile = ShellPrincipal();
  hostile.scheme_is_shell = false;
  assert(!policy::SharesShellProcess(hostile));
  hostile = ShellPrincipal();
  hostile.host = "settings";
  assert(!policy::SharesShellProcess(hostile));
}

void TestOnlyARegularProfileShares() {
  policy::Principal principal = ShellPrincipal();
  principal.has_profile = false;
  assert(!policy::SharesShellProcess(principal));

  principal = ShellPrincipal();
  principal.off_the_record = true;
  assert(!policy::SharesShellProcess(principal));

  principal = ShellPrincipal();
  principal.guest = true;
  assert(!policy::SharesShellProcess(principal));

  principal = ShellPrincipal();
  principal.sandboxed = true;
  assert(!policy::SharesShellProcess(principal));

  principal = ShellPrincipal();
  principal.webui = false;
  assert(!policy::SharesShellProcess(principal));
}

void TestTheAnswerIsAConstant() {
  static_assert(policy::SharesShellProcess(policy::Principal{
      .has_profile = true,
      .scheme_is_shell = true,
      .host = "ardia",
      .site = "chrome://ardia/",
      .webui = true,
  }));
  static_assert(!policy::SharesShellProcess(policy::Principal{}));
}

void TestReloadBudget() {
  policy::ShellReloadBudget budget;
  assert(budget.recent() == 0);
  assert(!budget.Allow(0, true));
  assert(budget.recent() == 0);
  for (size_t i = 0; i < policy::kShellReloadsAllowed; ++i) {
    assert(budget.Allow(1 + static_cast<double>(i), false));
  }
  assert(budget.recent() == policy::kShellReloadsAllowed);
  assert(!budget.Allow(10, false));
  assert(!budget.Allow(policy::kShellReloadWindowSeconds, false));
  assert(budget.Allow(1 + policy::kShellReloadWindowSeconds, false));
  assert(!budget.Allow(1.5 + policy::kShellReloadWindowSeconds, false));
  assert(budget.Allow(2 + policy::kShellReloadWindowSeconds, false));
  assert(budget.Allow(1000, false));
  assert(budget.recent() == 1);
  assert(!budget.Allow(1001, true));
  assert(budget.recent() == 1);

  policy::ShellReloadBudget crash_loop;
  size_t reloads = 0;
  for (int crash = 0; crash < 1000; ++crash) {
    if (crash_loop.Allow(crash * 0.01, false)) ++reloads;
  }
  assert(reloads == policy::kShellReloadsAllowed);
}

void TestEveryWindowOfASharedRendererRecoversOnce() {
  constexpr int kWindows = 8;
  policy::ShellReloadBudget windows[kWindows];
  for (int crash = 0; crash < 2; ++crash) {
    for (policy::ShellReloadBudget& window : windows) {
      assert(window.Allow(5 + crash, false));
    }
  }
  for (policy::ShellReloadBudget& window : windows) {
    assert(window.recent() == 2);
  }
}

}

int main() {
  TestOnlyTheShellSiteShares();
  TestOnlyARegularProfileShares();
  TestTheAnswerIsAConstant();
  TestReloadBudget();
  TestEveryWindowOfASharedRendererRecoversOnce();
  std::puts("webui_process_policy_test: all assertions passed");
  return 0;
}
