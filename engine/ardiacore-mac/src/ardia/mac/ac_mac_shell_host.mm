#include "ardia/mac/ac_mac_shell_host.h"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <set>
#include <utility>

#include "ardia/mac/ac_mac_glass.h"
#include "ardia/mac/ac_mac_shell_bridge.h"
#include "base/auto_reset.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/sys_string_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page.h"
#include "content/public/browser/reload_type.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/common/referrer.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/accelerators/accelerator_manager.h"
#include "ui/base/base_window.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/mojom/window_show_state.mojom.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "ui/gfx/geometry/rect_conversions.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia_mac {

namespace {

constexpr char kShellUrl[] = "chrome://ardia/";
constexpr size_t kUnhandledLimit = 400;
constexpr char kDirectoryPrefix[] = "Profile ";

class ShellTransparency : public content::WebContentsObserver {
 public:
  explicit ShellTransparency(content::WebContents* shell)
      : content::WebContentsObserver(shell) {
    Apply();
  }

  void PrimaryPageChanged(content::Page& page) override { Apply(); }
  void RenderViewReady() override { Apply(); }

 private:
  void Apply() {
    web_contents()->SetPageBaseBackgroundColor(SK_ColorTRANSPARENT);
    if (content::RenderWidgetHostView* view =
            web_contents()->GetRenderWidgetHostView()) {
      view->SetBackgroundColor(SK_ColorTRANSPARENT);
    }
  }
};

std::map<content::WebContents*, std::unique_ptr<ShellTransparency>>&
Transparencies() {
  static base::NoDestructor<
      std::map<content::WebContents*, std::unique_ptr<ShellTransparency>>>
      transparencies;
  return *transparencies;
}

}

std::string Text(const base::DictValue& value, std::string_view key) {
  const std::string* found = value.FindString(key);
  return found ? *found : std::string();
}

const base::ListValue* Arguments(const base::DictValue& value) {
  return value.FindList("args");
}

int TabId(const content::WebContents* contents) {
  return contents ? sessions::SessionTabHelper::IdForTab(contents).id() : 0;
}

base::Value Failure(std::string_view code, std::string_view message) {
  return base::Value(
      base::DictValue().Set("code", code).Set("message", message));
}

std::optional<gfx::Rect> RectFrom(const base::DictValue* rect) {
  if (!rect) {
    return std::nullopt;
  }
  const double x = rect->FindDouble("x").value_or(NAN);
  const double y = rect->FindDouble("y").value_or(NAN);
  const double width = rect->FindDouble("width").value_or(NAN);
  const double height = rect->FindDouble("height").value_or(NAN);
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) ||
      !std::isfinite(height) || width < 0 || height < 0 ||
      std::abs(x) > 1e6 || std::abs(y) > 1e6 || width > 1e6 || height > 1e6) {
    return std::nullopt;
  }
  return gfx::ToEnclosingRect(gfx::RectF(x, y, width, height));
}

void SubtractFromRegion(std::vector<gfx::Rect>& region, const gfx::Rect& cut) {
  std::vector<gfx::Rect> remaining;
  for (const gfx::Rect& piece : region) {
    gfx::Rect overlap = piece;
    overlap.Intersect(cut);
    if (overlap.IsEmpty()) {
      remaining.push_back(piece);
      continue;
    }
    for (const gfx::Rect& part :
         {gfx::Rect(piece.x(), piece.y(), piece.width(), overlap.y() - piece.y()),
          gfx::Rect(piece.x(), overlap.bottom(), piece.width(),
                    piece.bottom() - overlap.bottom()),
          gfx::Rect(piece.x(), overlap.y(), overlap.x() - piece.x(),
                    overlap.height()),
          gfx::Rect(overlap.right(), overlap.y(), piece.right() - overlap.right(),
                    overlap.height())}) {
      if (!part.IsEmpty()) {
        remaining.push_back(part);
      }
    }
  }
  region = std::move(remaining);
}

std::optional<GURL> AllowedPageUrl(const std::string& requested) {
  std::string text = requested.empty() ? "about:blank" : requested;
  if (base::StartsWith(text, "ardia://", base::CompareCase::INSENSITIVE_ASCII)) {
    text.replace(0, 8, "chrome://");
  }
  const GURL url(text);
  if (!url.is_valid() || url.SchemeIs("javascript")) {
    return std::nullopt;
  }
  const GURL inner = url.SchemeIs("view-source") ? GURL(url.GetContent()) : url;
  if (inner.SchemeIs("javascript") || inner.SchemeIs("view-source") ||
      (inner.SchemeIs("chrome") &&
       base::TrimString(inner.host(), ".", base::TRIM_TRAILING) == "ardia")) {
    return std::nullopt;
  }
  return url;
}

base::FilePath DataDirectory() {
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  if (command->HasSwitch("ardia-data-dir")) {
    return command->GetSwitchValuePath("ardia-data-dir");
  }
  if (const char* data = getenv("ARDIA_DATA_DIR"); data && *data) {
    return base::FilePath(data);
  }
  return g_browser_process->profile_manager()->user_data_dir().DirName();
}

base::FilePath AssetDirectory() {
  const base::CommandLine* command = base::CommandLine::ForCurrentProcess();
  if (command->HasSwitch("ardia-ui-dir")) {
    return command->GetSwitchValuePath("ardia-ui-dir");
  }
  return base::FilePath(base::SysNSStringToUTF8(
                            [[NSBundle mainBundle] resourcePath]))
      .Append("ardia-ui");
}

bool BackgroundInstance() {
  return base::CommandLine::ForCurrentProcess()->HasSwitch("ardia-background");
}

void Trace(const std::string& line) {
  LOG(WARNING) << "Ardia Mac WebUI: " << line;
}

bool ValidProfileId(std::string_view name) {
  if (name.empty() || name.size() > 128 || !base::IsAsciiAlpha(name[0])) {
    return false;
  }
  return std::ranges::all_of(name, [](char c) {
    return base::IsAsciiAlpha(c) || base::IsAsciiDigit(c) || c == '_' || c == '-';
  });
}

void WithProfile(std::string_view name,
                 base::OnceCallback<void(Profile*)> callback) {
  ProfileManager* manager = g_browser_process->profile_manager();
  const bool app_profile = name.empty() || name == "default";
  if (!app_profile && !ValidProfileId(name)) {
    std::move(callback).Run(nullptr);
    return;
  }
  const base::FilePath path =
      app_profile
          ? manager->user_data_dir().Append(ProfileManager::GetInitialProfileDir())
          : manager->user_data_dir().Append(std::string(kDirectoryPrefix) +
                                             std::string(name));
  if (Profile* loaded = manager->GetProfileByPath(path)) {
    std::move(callback).Run(loaded);
    return;
  }
  manager->CreateProfileAsync(
      path, base::BindOnce(
                [](std::string name, base::OnceCallback<void(Profile*)> callback,
                   Profile* profile) {
                  if (profile) {
                    for (ShellHostView* host : Hosts()) {
                      host->Emit("ArdiaProfiles", "profiles",
                                 base::Value(base::DictValue()
                                                 .Set("name", "profiles.loaded")
                                                 .Set("data", base::DictValue().Set(
                                                                  "profile", name))));
                    }
                  }
                  std::move(callback).Run(profile);
                },
                std::string(app_profile ? "default" : name), std::move(callback)));
}

std::string ProfileName(const Profile* profile) {
  const std::string directory =
      profile->GetOriginalProfile()->GetPath().BaseName().value();
  return directory.starts_with(kDirectoryPrefix)
             ? directory.substr(sizeof(kDirectoryPrefix) - 1)
             : "default";
}

std::vector<ShellHostView*>& Hosts() {
  static base::NoDestructor<std::vector<ShellHostView*>> hosts;
  return *hosts;
}

ShellHostView* HostForShell(content::WebContents* contents) {
  for (ShellHostView* host : Hosts()) {
    if (contents && host->shell_contents() == contents) {
      return host;
    }
  }
  return nullptr;
}

PageBinding::PageBinding(ShellHostView* owner,
                         content::WebContents* contents,
                         std::string key,
                         std::string profile)
    : content::WebContentsObserver(contents),
      owner_(owner),
      id_(TabId(contents)),
      key_(std::move(key)),
      profile_(std::move(profile)) {}

PageBinding::~PageBinding() {
  if (viewport && owner_) {
    viewport->SetWebContents(nullptr);
    owner_->RemoveChildViewT(viewport.get());
  }
  viewport = nullptr;
}

base::DictValue PageBinding::NavigationEvent() const {
  content::WebContents* contents = web_contents();
  base::DictValue data;
  if (contents) {
    data.Set("url", contents->GetVisibleURL().spec());
    data.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
    data.Set("canGoBack", contents->GetController().CanGoBack());
    data.Set("canGoForward", contents->GetController().CanGoForward());
    data.Set("isLoading", contents->IsLoading());
    data.Set("committedUrl", contents->GetLastCommittedURL().spec());
  }
  data.Set("themeColor", base::Value());
  data.Set("themeColorSource", base::Value());
  return base::DictValue().Set("name", "navigation").Set("data", std::move(data));
}

base::DictValue PageBinding::Envelope(std::string_view type) {
  return base::DictValue()
      .Set("type", type)
      .Set("claim", claim)
      .Set("rendererGeneration", base::NumberToString(renderer_generation))
      .Set("bindingGeneration", "1")
      .Set("documentEpoch", "1")
      .Set("sequence", static_cast<double>(++sequence));
}

void PageBinding::ReportNavigation() {
  if (!owner_ || claim.empty() || !web_contents()) {
    return;
  }
  base::DictValue delivery = Envelope("pageEvent");
  delivery.Set("event", NavigationEvent());
  owner_->Emit("ArdiaWebView", base::NumberToString(id_),
               base::Value(std::move(delivery)));
}

void PageBinding::ReportClosed() {
  if (!owner_ || claim.empty()) {
    return;
  }
  base::DictValue delivery = Envelope("pageEvent");
  delivery.Set("event", base::DictValue()
                            .Set("name", "windowClose")
                            .Set("data", base::DictValue()));
  owner_->Emit("ArdiaWebView", base::NumberToString(id_),
               base::Value(std::move(delivery)));
}

void PageBinding::DidFinishNavigation(content::NavigationHandle* handle) {
  if (handle->IsInPrimaryMainFrame()) {
    ReportNavigation();
  }
}

void PageBinding::TitleWasSet(content::NavigationEntry* entry) {
  ReportNavigation();
}

void PageBinding::DidStartLoading() {
  ReportNavigation();
}

void PageBinding::DidStopLoading() {
  ReportNavigation();
}

void PageBinding::WebContentsDestroyed() {
  ReportClosed();
  if (viewport) {
    viewport->SetWebContents(nullptr);
  }
  Observe(nullptr);
  if (owner_) {
    owner_->BindingGone(this);
  }
}

ShellHostView::ShellHostView(BrowserWindowInterface* browser,
                             BrowserView* browser_view,
                             Profile* app_profile,
                             std::string window_id)
    : browser_(browser),
      browser_view_(browser_view),
      app_profile_(app_profile),
      window_id_(std::move(window_id)) {
  Hosts().push_back(this);
}

ShellHostView::~ShellHostView() {
  DetachBrowser();
  std::erase(Hosts(), this);
}

void ShellHostView::Initialize() {
  view_observation_.Observe(browser_view_.get());
  focus_manager_ = GetFocusManager();
  shell_ = AddChildView(std::make_unique<views::WebView>(app_profile_.get()));
  content::WebContents* shell = shell_->GetWebContents();
  shell->SetDelegate(this);
  Transparencies()[shell] = std::make_unique<ShellTransparency>(shell);
  glass_ = std::make_unique<GlassRegions>(browser_view_->GetWidget());
  browser_->GetTabStripModel()->AddObserver(this);
  LayoutOverlay();
  shell_->LoadInitialURL(GURL(kShellUrl));
  Note("window " + window_id_ + " attached");
}

void ShellHostView::DetachBrowser() {
  if (!browser_) {
    return;
  }
  closing_ = true;
  RetireRenderer();
  TabStripModelObserver::StopObservingAll(this);
  CloseCompanions();
  for (auto& [id, binding] : bindings_) {
    if (binding->viewport) {
      binding->viewport->SetWebContents(nullptr);
    }
  }
  bindings_.clear();
  glass_.reset();
  if (focus_manager_) {
    focus_manager_->UnregisterAccelerators(this);
    focus_manager_ = nullptr;
  }
  if (shell_ && shell_->web_contents()) {
    Transparencies().erase(shell_->web_contents());
    shell_->web_contents()->SetDelegate(nullptr);
  }
  view_observation_.Reset();
  browser_ = nullptr;
}

content::WebContents* ShellHostView::shell_contents() const {
  return shell_ ? shell_->web_contents() : nullptr;
}

void ShellHostView::Note(const std::string& line) const {
  Trace(line);
}

std::vector<BrowserWindowInterface*> ShellHostView::Members() const {
  std::vector<BrowserWindowInterface*> members;
  if (!browser_) {
    return members;
  }
  members.push_back(browser_);
  for (const auto& companion : companions_) {
    if (companion) {
      members.push_back(companion.get());
    }
  }
  return members;
}

BrowserWindowInterface* ShellHostView::OwnerOf(
    const content::WebContents* contents) const {
  if (!contents) {
    return nullptr;
  }
  for (BrowserWindowInterface* member : Members()) {
    if (member->GetTabStripModel()->GetIndexOfWebContents(contents) !=
        TabStripModel::kNoTab) {
      return member;
    }
  }
  return nullptr;
}

bool ShellHostView::OwnsCompanion(const BrowserWindowInterface* browser) const {
  return std::ranges::any_of(companions_, [browser](const auto& companion) {
    return companion && companion.get() == browser;
  });
}

BrowserWindowInterface* ShellHostView::EnsureMember(Profile* profile) {
  if (!browser_ || !profile || closing_) {
    return nullptr;
  }
  for (BrowserWindowInterface* member : Members()) {
    if (member->GetProfile() == profile) {
      return member;
    }
  }
  if (profile->ShutdownStarted() ||
      GetBrowserWindowCreationStatusForProfile(*profile) !=
          BrowserWindowInterface::CreationStatus::kOk) {
    return nullptr;
  }
  BrowserWindowCreateParams params(BrowserWindowInterface::TYPE_NORMAL,
                                   *profile, false);
  params.omit_from_session_restore = true;
  params.should_trigger_session_restore = false;
  params.initial_bounds = browser_->GetWindow()->GetBounds();
  params.initial_show_state = ui::mojom::WindowShowState::kNormal;
  BrowserWindowInterface* created = CreateBrowserWindow(std::move(params));
  if (!created) {
    return nullptr;
  }
  companions_.push_back(created->GetWeakPtr());
  created->GetTabStripModel()->AddObserver(this);
  Note("companion window joined " + window_id_);
  return created;
}

void ShellHostView::CloseCompanions() {
  std::vector<base::WeakPtr<BrowserWindowInterface>> companions =
      std::move(companions_);
  companions_.clear();
  for (const auto& companion : companions) {
    if (!companion) {
      continue;
    }
    TabStripModel* model = companion->GetTabStripModel();
    model->RemoveObserver(this);
    while (model->count() > 0) {
      model->DetachAndDeleteWebContentsAt(model->count() - 1);
    }
    companion->GetWindow()->Close();
  }
}

PageBinding* ShellHostView::BindingForKey(std::string_view key) const {
  for (const auto& [id, binding] : bindings_) {
    if (binding->key() == key && binding->contents()) {
      return binding.get();
    }
  }
  return nullptr;
}

PageBinding* ShellHostView::BindingForContents(
    const content::WebContents* contents) const {
  if (!contents) {
    return nullptr;
  }
  for (const auto& [id, binding] : bindings_) {
    if (binding->contents() == contents) {
      return binding.get();
    }
  }
  return nullptr;
}

void ShellHostView::BindingGone(PageBinding* binding) {
  const int id = binding->id();
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<ShellHostView> host, int id) {
                       if (!host) {
                         return;
                       }
                       auto found = host->bindings_.find(id);
                       if (found != host->bindings_.end() &&
                           !found->second->contents()) {
                         host->bindings_.erase(found);
                       }
                     },
                     GetWeakPtr(), id));
}

bool ShellHostView::OwnsShellNativeView(gfx::NativeView view) const {
  content::WebContents* shell = shell_contents();
  return shell && view && shell->GetNativeView() == view;
}

bool ShellHostView::PassesShellPoint(const gfx::Point& point) const {
  return std::ranges::any_of(
      pass_, [&](const gfx::Rect& rect) { return rect.Contains(point); });
}

void ShellHostView::LayoutOverlay() {
  if (!browser_view_) {
    return;
  }
  SetBoundsRect(browser_view_->GetLocalBounds());
  if (shell_) {
    shell_->SetBoundsRect(GetLocalBounds());
  }
  if (views::WebView* chrome_view = browser_view_->GetActiveContentsWebView()) {
    chrome_view->SetVisible(false);
  }
  Restack();
}

void ShellHostView::Restack() {
  if (!shell_ || !browser_view_) {
    return;
  }
  browser_view_->ReorderChildView(this, browser_view_->children().size());
  ReorderChildView(shell_, children().size());
}

void ShellHostView::ReattachViewports() {
  std::set<content::WebContents*> taken;
  for (BrowserWindowInterface* member : Members()) {
    BrowserView* view = BrowserView::GetBrowserViewForBrowser(member);
    if (!view) {
      continue;
    }
    if (views::WebView* chrome_view = view->GetActiveContentsWebView()) {
      if (content::WebContents* held = chrome_view->web_contents()) {
        taken.insert(held);
      }
      chrome_view->SetWebContents(nullptr);
      chrome_view->SetVisible(false);
    }
  }
  for (auto& [id, binding] : bindings_) {
    views::WebView* page = binding->viewport;
    content::WebContents* contents = binding->contents();
    if (!page || !contents || !binding->visible) {
      continue;
    }
    if (taken.contains(contents) || page->web_contents() != contents) {
      page->SetWebContents(nullptr);
      page->SetWebContents(contents);
    }
  }
  Restack();
}

void ShellHostView::OnViewBoundsChanged(views::View* observed_view) {
  LayoutOverlay();
}

void ShellHostView::OnViewIsDeleting(views::View* observed_view) {
  view_observation_.Reset();
  browser_view_ = nullptr;
}

void ShellHostView::FocusShell() {
  if (!shell_) {
    return;
  }
  shell_->RequestFocus();
  if (content::WebContents* contents = shell_contents()) {
    contents->Focus();
  }
}

bool ShellHostView::Trusted(content::WebUI* ui) const {
  content::WebContents* shell = shell_contents();
  if (!ui || !shell || ui->GetWebContents() != shell) {
    return false;
  }
  content::RenderFrameHost* frame = shell->GetPrimaryMainFrame();
  return frame && frame->IsRenderFrameLive() &&
         ui->GetRenderFrameHost() == frame && frame->GetWebUI() == ui &&
         frame->GetLastCommittedOrigin() ==
             url::Origin::Create(GURL(kShellUrl)) &&
         shell->GetLastCommittedURL().host() == "ardia";
}

uint64_t ShellHostView::SetHandler(ShellBridge* handler, content::WebUI* ui) {
  if (!Trusted(ui)) {
    return 0;
  }
  content::RenderFrameHost* frame = ui->GetRenderFrameHost();
  if (handler_ == handler &&
      renderer_document_.AsRenderFrameHostIfValid() == frame) {
    return renderer_generation_;
  }
  RetireRenderer();
  handler_ = handler;
  renderer_document_ = frame->GetWeakDocumentPtr();
  return renderer_generation_;
}

bool ShellHostView::OwnsHandler(const ShellBridge* handler,
                                uint64_t generation) const {
  content::RenderFrameHost* frame =
      renderer_document_.AsRenderFrameHostIfValid();
  return handler && handler_ == handler && generation &&
         renderer_generation_ == generation && frame && shell_contents() &&
         frame == shell_contents()->GetPrimaryMainFrame();
}

void ShellHostView::ClearHandler(ShellBridge* handler) {
  if (!handler || handler_ != handler) {
    return;
  }
  RetireRenderer();
}

void ShellHostView::NoteRequest(base::WeakPtr<ShellBridge> handler,
                                uint64_t generation) {
  request_handler_ = std::move(handler);
  request_generation_ = generation;
}

void ShellHostView::RetireRenderer() {
  const bool had_document = handler_ != nullptr;
  handler_ = nullptr;
  renderer_document_ = content::WeakDocumentPtr();
  ++renderer_generation_;
  if (!had_document) {
    return;
  }
  for (auto& [id, binding] : bindings_) {
    binding->claim.clear();
    binding->renderer_generation = 0;
    binding->visible = false;
    if (binding->viewport) {
      binding->viewport->SetVisible(false);
      binding->viewport->SetWebContents(nullptr);
    }
  }
  pass_.clear();
  if (focus_manager_) {
    focus_manager_->UnregisterAccelerators(this);
  }
  shortcuts_.clear();
}

void ShellHostView::DeliverReply(base::WeakPtr<ShellBridge> handler,
                                 uint64_t generation,
                                 std::string id,
                                 bool success,
                                 base::Value response) {
  if (!handler || !OwnsHandler(handler.get(), generation)) {
    return;
  }
  handler->Reply(id, success, std::move(response));
}

void ShellHostView::Emit(std::string_view module,
                         std::string_view event,
                         base::Value payload) {
  if (handler_ && OwnsHandler(handler_, handler_->generation())) {
    handler_->Send(module, event, payload);
  }
}

void ShellHostView::NoteUnhandled(const std::string& method) {
  if (unhandled_.size() >= kUnhandledLimit ||
      std::ranges::find(unhandled_, method) != unhandled_.end()) {
    return;
  }
  unhandled_.push_back(method);
  Note("unhandled host call " + method);
}

PageBinding* ShellHostView::ClaimedBinding(const base::DictValue& args) const {
  const std::optional<int> id = args.FindInt("id");
  const auto found = id ? bindings_.find(*id) : bindings_.end();
  if (found == bindings_.end() || !found->second->contents() ||
      found->second->claim.empty() ||
      found->second->claim != Text(args, "claim")) {
    return nullptr;
  }
  return found->second.get();
}

base::DictValue ShellHostView::Identity(PageBinding* binding) const {
  base::DictValue lease;
  lease.Set("claim", binding->claim);
  lease.Set("rendererGeneration",
            base::NumberToString(binding->renderer_generation));
  lease.Set("bindingGeneration", "1");
  lease.Set("documentEpoch", "1");
  base::DictValue snapshot;
  snapshot.Set("watermark", static_cast<double>(binding->sequence));
  snapshot.Set("events", base::ListValue().Append(binding->NavigationEvent()));
  return base::DictValue()
      .Set("browserId", binding->id())
      .Set("chromeTabId", binding->id())
      .Set("lease", std::move(lease))
      .Set("snapshot", std::move(snapshot));
}

void ShellHostView::CreateTab(const base::DictValue& args, Done done) {
  const std::string key = Text(args, "key");
  const std::string claim = Text(args, "claim");
  if (key.empty() || key.size() > 256 || claim.empty() || claim.size() > 256) {
    return std::move(done).Run(false,
                               base::Value("A key and a claim are required"));
  }
  if (!AllowedPageUrl(Text(args, "url"))) {
    return std::move(done).Run(false, base::Value("Invalid or reserved tab URL"));
  }
  if (!browser_) {
    return std::move(done).Run(false, base::Value("This window has no tabs"));
  }
  const std::string profile = Text(args, "profile");
  WithProfile(profile,
              base::BindOnce(&ShellHostView::CreateTabIn, GetWeakPtr(),
                             args.Clone(), std::move(done), request_handler_,
                             request_generation_));
}

void ShellHostView::CreateTabIn(base::DictValue args,
                                Done done,
                                base::WeakPtr<ShellBridge> origin,
                                uint64_t generation,
                                Profile* profile) {
  if (!origin || !OwnsHandler(origin.get(), generation)) {
    return std::move(done).Run(
        false, base::Value("The shell document that asked for this tab is gone"));
  }
  if (!profile || !browser_) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE", "The tab's profile did not load"));
  }
  const std::optional<GURL> url = AllowedPageUrl(Text(args, "url"));
  const std::string key = Text(args, "key");
  const std::string claim = Text(args, "claim");
  BrowserWindowInterface* member =
      profile == browser_->GetProfile() ? browser_.get() : EnsureMember(profile);
  if (!member || !url) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_UNAVAILABLE",
                       "The tab's profile has no window to live in"));
  }
  if (PageBinding* existing = BindingForKey(key)) {
    if (existing->contents()->GetBrowserContext() == profile) {
      existing->claim = claim;
      existing->renderer_generation = renderer_generation_;
      ReattachViewports();
      return std::move(done).Run(true, base::Value(Identity(existing)));
    }
    bindings_.erase(existing->id());
  }
  content::WebContents* contents = nullptr;
  {
    NavigateParams params(member, *url, ui::PAGE_TRANSITION_AUTO_TOPLEVEL);
    params.disposition = WindowOpenDisposition::kNewBackgroundTab;
    params.window_action = NavigateParams::WindowAction::kNoAction;
    Navigate(&params);
    contents = params.navigated_or_inserted_contents;
  }
  if (!contents) {
    return std::move(done).Run(false, base::Value("The tab did not open"));
  }
  auto binding = std::make_unique<PageBinding>(this, contents, key,
                                               Text(args, "profile"));
  binding->claim = claim;
  binding->renderer_generation = renderer_generation_;
  PageBinding* created = binding.get();
  bindings_[created->id()] = std::move(binding);
  ReattachViewports();
  std::move(done).Run(true, base::Value(Identity(created)));
}

void ShellHostView::SetViewport(const base::DictValue& args, Done done) {
  PageBinding* binding = ClaimedBinding(args);
  if (!binding) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  const bool visible = args.FindBool("visible").value_or(false);
  const std::optional<gfx::Rect> rect = RectFrom(args.FindDict("rect"));
  if (!binding->viewport) {
    binding->viewport = AddChildViewAt(
        std::make_unique<views::WebView>(binding->contents()->GetBrowserContext()),
        0);
    binding->viewport->SetVisible(false);
  }
  if (visible && rect && !rect->IsEmpty()) {
    binding->viewport->SetBoundsRect(*rect);
    binding->viewport->SetVisible(true);
    binding->visible = true;
  } else {
    binding->viewport->SetVisible(false);
    binding->viewport->SetWebContents(nullptr);
    binding->visible = false;
  }
  ReattachViewports();
  std::move(done).Run(true, base::Value());
}

void ShellHostView::SetPresentations(const base::DictValue& args, Done done) {
  const base::ListValue* tabs = args.FindList("tabs");
  if (!tabs || tabs->size() > 64) {
    return std::move(done).Run(false,
                               base::Value("A tab presentation list is required"));
  }
  std::map<BrowserWindowInterface*, content::WebContents*> activate;
  for (const base::Value& tab : *tabs) {
    const base::DictValue* item = tab.GetIfDict();
    PageBinding* binding = item ? ClaimedBinding(*item) : nullptr;
    const std::optional<bool> visible =
        item ? item->FindBool("visible") : std::nullopt;
    if (!binding || !visible) {
      continue;
    }
    binding->presented = *visible;
    if (*visible) {
      if (BrowserWindowInterface* owner = OwnerOf(binding->contents())) {
        activate[owner] = binding->contents();
      }
    }
  }
  for (const auto& [owner, contents] : activate) {
    TabStripModel* model = owner->GetTabStripModel();
    const int index = model->GetIndexOfWebContents(contents);
    if (index != TabStripModel::kNoTab && index != model->active_index()) {
      model->ActivateTabAt(index);
    }
  }
  ReattachViewports();
  std::move(done).Run(true, base::Value());
}

void ShellHostView::TabCommand(const base::DictValue& args, Done done) {
  PageBinding* binding = ClaimedBinding(args);
  if (!binding) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  content::WebContents* contents = binding->contents();
  const std::string command = Text(args, "command");
  const base::ListValue* values = Arguments(args);
  content::NavigationController& controller = contents->GetController();
  if (command == "loadUrl") {
    const std::optional<GURL> url =
        values && !values->empty() && (*values)[0].is_string()
            ? AllowedPageUrl((*values)[0].GetString())
            : std::nullopt;
    if (!url) {
      return std::move(done).Run(false, base::Value("Invalid or reserved URL"));
    }
    controller.LoadURL(*url, content::Referrer(), ui::PAGE_TRANSITION_TYPED,
                       std::string());
    return std::move(done).Run(true, base::Value());
  }
  if (command == "goBack" && controller.CanGoBack()) {
    controller.GoBack();
  } else if (command == "goForward" && controller.CanGoForward()) {
    controller.GoForward();
  } else if (command == "reload" || command == "forceReload") {
    controller.Reload(command == "reload" ? content::ReloadType::NORMAL
                                          : content::ReloadType::BYPASSING_CACHE,
                      true);
  } else if (command == "stopLoading") {
    contents->Stop();
  } else if (command == "focus") {
    if (binding->viewport) {
      binding->viewport->RequestFocus();
    }
    contents->Focus();
  } else if (command == "blur") {
    FocusShell();
  } else if (command == "setMuted" && values && !values->empty() &&
             (*values)[0].is_bool()) {
    contents->SetAudioMuted((*values)[0].GetBool());
  } else if (command == "close") {
    std::move(done).Run(true, base::Value());
    return CloseContents(contents);
  } else if (command == "navigationEntries") {
    base::ListValue entries;
    const int current = controller.GetCurrentEntryIndex();
    for (int index = 0; index < std::min(controller.GetEntryCount(), 1000);
         ++index) {
      content::NavigationEntry* entry = controller.GetEntryAtIndex(index);
      entries.Append(base::DictValue()
                         .Set("url", entry->GetVirtualURL().spec())
                         .Set("title", base::UTF16ToUTF8(entry->GetTitle()))
                         .Set("current", index == current));
    }
    return std::move(done).Run(true, base::Value(std::move(entries)));
  } else {
    NoteUnhandled("tab.command " + command);
  }
  std::move(done).Run(true, base::Value());
}

void ShellHostView::ReleaseTab(const base::DictValue& args, Done done) {
  const std::optional<int> id = args.FindInt("id");
  auto found = id ? bindings_.find(*id) : bindings_.end();
  if (found == bindings_.end()) {
    return std::move(done).Run(true, base::Value());
  }
  PageBinding* binding = found->second.get();
  if (binding->claim != Text(args, "claim")) {
    return std::move(done).Run(false, base::Value("No owned live tab"));
  }
  binding->claim.clear();
  binding->visible = false;
  binding->presented = false;
  if (binding->viewport) {
    binding->viewport->SetVisible(false);
    binding->viewport->SetWebContents(nullptr);
  }
  std::move(done).Run(true, base::Value());
}

void ShellHostView::CloseTab(const base::DictValue& args, Done done) {
  PageBinding* binding = BindingForKey(Text(args, "key"));
  std::move(done).Run(true, base::Value());
  if (binding) {
    CloseContents(binding->contents());
  }
}

void ShellHostView::CloseContents(content::WebContents* contents) {
  BrowserWindowInterface* owner = OwnerOf(contents);
  if (!owner) {
    return;
  }
  TabStripModel* model = owner->GetTabStripModel();
  const int index = model->GetIndexOfWebContents(contents);
  if (index != TabStripModel::kNoTab) {
    model->CloseWebContentsAt(index, TabCloseTypes::CLOSE_USER_GESTURE);
  }
}

void ShellHostView::SetInputRegions(const base::DictValue& args, Done done) {
  const auto read = [](const base::ListValue* list,
                       std::vector<gfx::Rect>& out) {
    if (!list || list->size() > 64) {
      return false;
    }
    for (const base::Value& entry : *list) {
      const std::optional<gfx::Rect> rect = RectFrom(entry.GetIfDict());
      if (!rect) {
        return false;
      }
      if (!rect->IsEmpty()) {
        out.push_back(*rect);
      }
    }
    return true;
  };
  std::vector<gfx::Rect> pages;
  std::vector<gfx::Rect> overlays;
  if (!read(args.FindList("pages"), pages) ||
      !read(args.FindList("overlays"), overlays)) {
    return std::move(done).Run(
        false, base::Value("Input regions need pages and overlays as lists"));
  }
  std::vector<gfx::Rect> pass;
  for (const gfx::Rect& page : pages) {
    std::vector<gfx::Rect> open{page};
    for (const gfx::Rect& overlay : overlays) {
      SubtractFromRegion(open, overlay);
    }
    pass.insert(pass.end(), open.begin(), open.end());
  }
  pass_ = std::move(pass);
  std::move(done).Run(true, base::Value());
}

void ShellHostView::SetGlassRegions(const base::DictValue& args, Done done) {
  const base::ListValue* regions = args.FindList("regions");
  if (!regions || !glass_) {
    return std::move(done).Run(false, base::Value("Glass regions are a list"));
  }
  std::vector<GlassRegion> parsed;
  for (const base::Value& value : *regions) {
    const base::DictValue* region = value.GetIfDict();
    const std::optional<gfx::Rect> rect =
        region ? RectFrom(region->FindDict("rect")) : std::nullopt;
    if (!rect) {
      continue;
    }
    parsed.push_back({*rect, region->FindDouble("radius").value_or(0),
                      Text(*region, "material"), Text(*region, "kind")});
  }
  glass_->Apply(parsed);
  std::move(done).Run(true, base::Value(static_cast<int>(parsed.size())));
}

void ShellHostView::StartWindowMove(Done done) {
  views::Widget* widget = browser_view_ ? browser_view_->GetWidget() : nullptr;
  NSWindow* window =
      widget ? widget->GetNativeWindow().GetNativeNSWindow() : nil;
  NSEvent* event = [NSApp currentEvent];
  if (!window || !event || event.type != NSEventTypeLeftMouseDown) {
    return std::move(done).Run(true, base::Value(false));
  }
  [window performWindowDragWithEvent:event];
  std::move(done).Run(true, base::Value(true));
}

void ShellHostView::OnTabStripModelChanged(
    TabStripModel* tab_strip_model,
    const TabStripModelChange& change,
    const TabStripSelectionChange& selection) {
  ReattachViewports();
}

bool ShellHostView::HandleKeyboardEvent(
    content::WebContents* source,
    const input::NativeWebKeyboardEvent& event) {
  if (!focus_manager_) {
    return false;
  }
  return unhandled_keys_.HandleKeyboardEvent(event, focus_manager_);
}

bool ShellHostView::AcceleratorPressed(const ui::Accelerator& accelerator) {
  auto found = shortcuts_.find(accelerator);
  if (found == shortcuts_.end()) {
    return false;
  }
  const std::string command = Text(found->second, "command");
  if (command == "focusCommandBar" || command == "newTab") {
    FocusShell();
  }
  base::DictValue payload;
  payload.Set("command", command);
  if (const base::Value* arg = found->second.Find("arg")) {
    payload.Set("arg", arg->Clone());
  } else {
    payload.Set("arg", base::Value());
  }
  payload.Set("windowId", window_id_);
  payload.Set("shortcutModifiers", accelerator.modifiers());
  Emit("ArdiaShell", "onCommand", base::Value(std::move(payload)));
  return true;
}

bool ShellHostView::CanHandleAccelerators() const {
  return browser_ && handler_;
}

void ShellHostView::SetKeyboardShortcuts(const base::ListValue* values,
                                         Done done) {
  if (!focus_manager_ || !values || values->empty() ||
      !(*values)[0].is_list() || (*values)[0].GetList().size() > 256) {
    return std::move(done).Run(false,
                               base::Value("Invalid keyboard shortcut table"));
  }
  std::map<ui::Accelerator, base::DictValue> shortcuts;
  for (const base::Value& value : (*values)[0].GetList()) {
    if (!value.is_dict()) {
      continue;
    }
    const base::DictValue& binding = value.GetDict();
    const int key = binding.FindInt("keyCode").value_or(0);
    const int flags = binding.FindInt("modifiers").value_or(-1);
    if (key < 1 || key > 255 || flags < 0 || Text(binding, "command").empty()) {
      continue;
    }
    shortcuts.emplace(ui::Accelerator(static_cast<ui::KeyboardCode>(key), flags),
                      binding.Clone());
  }
  focus_manager_->UnregisterAccelerators(this);
  shortcuts_ = std::move(shortcuts);
  for (const auto& [accelerator, binding] : shortcuts_) {
    focus_manager_->RegisterAccelerator(
        accelerator, ui::AcceleratorManager::kNormalPriority, this);
  }
  std::move(done).Run(true, base::Value());
}

BEGIN_METADATA(ShellHostView)
END_METADATA

}
