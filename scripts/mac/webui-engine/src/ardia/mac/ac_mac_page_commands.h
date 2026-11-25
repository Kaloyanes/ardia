#ifndef ARDIA_MAC_AC_MAC_PAGE_COMMANDS_H_
#define ARDIA_MAC_AC_MAC_PAGE_COMMANDS_H_

#include <string>
#include <string_view>

#include "ardia/mac/ac_mac_page_policy.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "components/find_in_page/find_result_observer.h"

class Profile;

namespace content {
class WebContents;
}

namespace find_in_page {
class FindTabHelper;
}

namespace ardia_mac {

class PageBinding;

class PageCommands : public find_in_page::FindResultObserver {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  explicit PageCommands(PageBinding* binding);
  PageCommands(const PageCommands&) = delete;
  PageCommands& operator=(const PageCommands&) = delete;
  ~PageCommands() override;

  static bool Handles(std::string_view command);
  void Run(const std::string& command, const base::ListValue& args, Done done);
  void Reset();

 private:
  content::WebContents* Live() const;
  void Find(const base::ListValue& args, Done done);
  void StopFinding(const base::ListValue& args, Done done);
  void PageAction(const base::ListValue& args, Done done);
  void DevTools(const base::ListValue& args, Done done);
  void Evaluate(const base::ListValue& args, Done done);
  void Edit(const base::ListValue& args, Done done);
  void Discard(const base::ListValue& args, Done done);
  void SetFrozen(const base::ListValue& args, Done done);
  void DownloadFavicon(const base::ListValue& args, Done done);
  void DownloadImage(const base::ListValue& args, Done done);
  void OpenBlockedPopup(const base::ListValue& args, Done done);
  void ResolveUnresponsive(const base::ListValue& args, Done done);
  base::Value Print(bool system);
  base::Value Save();
  base::Value ViewSource();
  page_policy::Protection CurrentProtection() const;
  void SendFind(int count, int active, bool final);
  void OnFindResultAvailable(content::WebContents* contents) override;
  void OnFindEmptyText(content::WebContents* contents) override;
  void OnFindTabHelperDestroyed(find_in_page::FindTabHelper* helper) override;

  raw_ptr<PageBinding> binding_;
  raw_ptr<find_in_page::FindTabHelper> observed_ = nullptr;
  bool frozen_ = false;
  base::WeakPtrFactory<PageCommands> weak_factory_{this};
};

void SiteZoomCall(const std::string& name,
                  Profile* profile,
                  const base::Value* args,
                  base::OnceCallback<void(bool, base::Value)> done);

}

#endif
