#ifndef ARDIA_MAC_AC_MAC_LINK_GESTURE_H_
#define ARDIA_MAC_AC_MAC_LINK_GESTURE_H_

#include <cstdint>
#include <optional>
#include <set>
#include <string_view>

#include "ardia/mac/ac_mac_link_policy.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_observer.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace content {
struct OpenURLParams;
}

namespace ardia_mac {

class PageBinding;

class PageLinks : public content::WebContentsObserver,
                  public content::RenderWidgetHost::InputEventObserver,
                  public content::RenderWidgetHostObserver {
 public:
  PageLinks(PageBinding* binding, content::WebContents* contents);
  PageLinks(const PageLinks&) = delete;
  PageLinks& operator=(const PageLinks&) = delete;
  ~PageLinks() override;

  std::uintptr_t surface() const;

 private:
  void Watch(content::RenderWidgetHost* widget);
  void Unwatch();
  void RenderFrameCreated(content::RenderFrameHost* frame) override;
  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override;
  void DidStartNavigation(content::NavigationHandle* handle) override;
  void DidFinishNavigation(content::NavigationHandle* handle) override;
  void WebContentsDestroyed() override;
  void OnInputEvent(const content::RenderWidgetHost& widget,
                    const blink::WebInputEvent& event,
                    input::InputEventSource source) override;
  void RenderWidgetHostDestroyed(content::RenderWidgetHost* widget) override;
  void PeekInsteadOf(int64_t navigation);

  raw_ptr<PageBinding> binding_;
  std::uintptr_t surface_ = 0;
  std::set<content::RenderWidgetHost*> widgets_;
  int64_t site_navigation_ = 0;
  GURL site_url_;
  std::optional<link_policy::Point> site_point_;
  base::WeakPtrFactory<PageLinks> weak_factory_{this};
};

bool HandlesLinkRoute(std::string_view name);
void LinkRouteCall(std::string_view name,
                   const base::Value* args,
                   base::OnceCallback<void(bool, base::Value)> done);
void AppendLinkCapabilities(base::ListValue& capabilities);
bool InterceptLinkOpen(content::WebContents* source, const content::OpenURLParams& params);
bool InterceptLinkDownload(const GURL& url);
WindowOpenDisposition PopupDisposition(content::WebContents* source,
                                       WindowOpenDisposition disposition);
bool OpensNewTabLinkInPlace(content::WebContents* source,
                            const GURL& url,
                            WindowOpenDisposition disposition,
                            bool user_gesture);
void InstallCommandScrollZoom();

}

#endif
