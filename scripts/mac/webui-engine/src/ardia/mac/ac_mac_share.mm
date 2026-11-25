#include "ardia/mac/ac_mac_share.h"

#import <AppKit/AppKit.h>

#include <errno.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_glass_layout.h"
#include "ardia/mac/ac_mac_hooks.h"
#include "ardia/mac/ac_mac_share_policy.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/sys_string_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/uuid.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/common/chrome_render_frame.mojom.h"
#include "components/lens/lens_metadata.mojom.h"
#include "components/renderer_context_menu/render_view_context_menu_base.h"
#include "components/renderer_context_menu/render_view_context_menu_observer.h"
#include "components/zoom/zoom_controller.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "third_party/blink/public/mojom/context_menu/context_menu.mojom.h"
#include "ui/gfx/geometry/size.h"
#include "ui/menus/simple_menu_model.h"
#include "url/gurl.h"

namespace ardia_mac::share {
void PickerChose(std::uint64_t request, NSSharingServicePicker* picker, bool cancelled);
void ServiceFinished(std::uint64_t request);
NSWindow* SourceWindow(std::uint64_t request);
}

@interface ArdiaMacShareRequest : NSObject <NSSharingServicePickerDelegate, NSSharingServiceDelegate>
- (instancetype)initWithRequest:(std::uint64_t)request;
@property(nonatomic, readonly) std::uint64_t request;
@end

@implementation ArdiaMacShareRequest

@synthesize request = _request;

- (instancetype)initWithRequest:(std::uint64_t)request {
  if ((self = [super init])) {
    _request = request;
  }
  return self;
}

- (id<NSSharingServiceDelegate>)sharingServicePicker:(NSSharingServicePicker*)picker
                           delegateForSharingService:(NSSharingService*)service {
  return self;
}

- (void)sharingServicePicker:(NSSharingServicePicker*)picker
     didChooseSharingService:(NSSharingService*)service {
  ardia_mac::share::PickerChose(_request, picker, service == nil);
}

- (void)sharingService:(NSSharingService*)service didShareItems:(NSArray*)items {
  ardia_mac::share::ServiceFinished(_request);
}

- (void)sharingService:(NSSharingService*)service
    didFailToShareItems:(NSArray*)items
                  error:(NSError*)error {
  ardia_mac::share::ServiceFinished(_request);
}

- (NSWindow*)sharingService:(NSSharingService*)service
    sourceWindowForShareItems:(NSArray*)items
          sharingContentScope:(NSSharingContentScope*)scope {
  return ardia_mac::share::SourceWindow(_request);
}

@end

namespace ardia_mac::share {

namespace {

using Done = ShellHostView::Done;
using MediaType = blink::mojom::ContextMenuDataMediaType;
using ChromeRenderFrame = mojo::AssociatedRemote<chrome::mojom::ChromeRenderFrame>;

constexpr int kShareFirst = IDC_CONTENT_CONTEXT_CUSTOM_FIRST + 890;
constexpr int kLargestSharedImage = 8192;
constexpr int kMaxSharedImageBytes = 64 * 1024 * 1024;
constexpr char kSharedImagesFolder[] = "ardia-webui-shared-images";
constexpr char kSharingSettings[] =
    "x-apple.systempreferences:com.apple.ExtensionsPreferences?extensionPointIdentifier=com.apple.share-services";

constexpr std::string_view kCapabilities[] = {
    "ArdiaApp.share",
    "ArdiaApp.shareText",
    "ArdiaApp.shareVia",
    "ArdiaApp.shareServices",
    "ArdiaApp.openSharingSettings",
};

struct Request {
  std::string owner;
  ArdiaMacShareRequest* delegate = nil;
  NSSharingServicePicker* picker = nil;
  __weak NSWindow* window = nil;
  std::optional<Done> done;
  std::optional<base::FilePath> file;
};

std::map<std::uint64_t, Request>& Requests() {
  static base::NoDestructor<std::map<std::uint64_t, Request>> requests;
  return *requests;
}

std::uint64_t NextRequest() {
  static std::uint64_t next = 0;
  return ++next;
}

share_policy::IssuedFiles<std::string>& Issued() {
  static base::NoDestructor<share_policy::IssuedFiles<std::string>> issued;
  return *issued;
}

base::FilePath SharedImagesRoot() {
  return base::FilePath(base::SysNSStringToUTF8(NSTemporaryDirectory())).Append(kSharedImagesFolder);
}

const base::FilePath& InstanceDirectory() {
  static base::NoDestructor<base::FilePath> directory([] {
    const std::optional<std::string> name = share_policy::InstanceDirectoryName(
        static_cast<long>(getpid()), base::Uuid::GenerateRandomV4().AsLowercaseString());
    return SharedImagesRoot().Append(name.value_or("instance"));
  }());
  return *directory;
}

std::string StandardPath(const std::string& path) {
  return base::SysNSStringToUTF8([NSURL fileURLWithPath:base::SysUTF8ToNSString(path)].path.stringByStandardizingPath);
}

bool UnderSharedImages(const std::string& path) {
  const std::string root = StandardPath(SharedImagesRoot().value());
  return path.size() > root.size() && path.starts_with(root) && path[root.size()] == '/';
}

bool InInstanceDirectory(const std::string& path) {
  return share_policy::InsideDirectory(path, StandardPath(InstanceDirectory().value()));
}

void RemoveTemporary(const base::FilePath& path) {
  if (!InInstanceDirectory(StandardPath(path.value()))) {
    return;
  }
  base::ThreadPool::PostTask(FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
                             base::BindOnce(base::IgnoreResult(&base::DeleteFile), path));
}

void Settle(Request& request) {
  if (request.done) {
    Done done = std::move(*request.done);
    request.done.reset();
    std::move(done).Run(true, base::Value());
  }
}

void EndRequest(std::uint64_t id) {
  auto found = Requests().find(id);
  if (found == Requests().end()) {
    return;
  }
  Request request = std::move(found->second);
  Requests().erase(found);
  if (request.file) {
    RemoveTemporary(*request.file);
  }
  Settle(request);
}

std::string StringAt(const base::ListValue* values, size_t index) {
  return values && index < values->size() && (*values)[index].is_string() ? (*values)[index].GetString()
                                                                           : std::string();
}

std::optional<std::string> OptionalStringAt(const base::ListValue* values, size_t index) {
  if (!values || index >= values->size() || !(*values)[index].is_string()) {
    return std::nullopt;
  }
  return (*values)[index].GetString();
}

std::optional<share_policy::Anchor> AnchorAt(const base::ListValue* values, size_t index) {
  if (!values || index >= values->size() || !(*values)[index].is_list()) {
    return std::nullopt;
  }
  const base::ListValue& list = (*values)[index].GetList();
  if (list.size() != 4) {
    return std::nullopt;
  }
  double numbers[4] = {};
  for (size_t at = 0; at < 4; ++at) {
    if (!list[at].is_int() && !list[at].is_double()) {
      return std::nullopt;
    }
    numbers[at] = list[at].GetDouble();
  }
  return share_policy::AnchorFrom(4, numbers);
}

ShellHostView* TargetHost(ShellHostView& caller, const std::optional<std::string>& window_id) {
  if (window_id && !window_id->empty()) {
    for (ShellHostView* host : Hosts()) {
      if (host->window_id() == *window_id) {
        return host;
      }
    }
  }
  return &caller;
}

double ZoomOf(content::WebContents* contents) {
  if (!contents) {
    return 1;
  }
  return glass::SanitizedScale(
      blink::ZoomLevelToZoomFactor(zoom::ZoomController::GetZoomLevelForWebContents(contents)));
}

NSView* ShellView(ShellHostView* host) {
  content::WebContents* shell = host ? host->shell_contents() : nullptr;
  content::RenderWidgetHostView* view = shell ? shell->GetRenderWidgetHostView() : nullptr;
  return view ? view->GetNativeView().GetNativeNSView() : nil;
}

struct Placement {
  NSRect rect;
  NSRectEdge edge;
};

Placement PlacementFor(NSView* view, const std::optional<share_policy::Anchor>& requested, double zoom) {
  const double width_in_css = NSWidth(view.bounds) / (zoom > 0 ? zoom : 1);
  const share_policy::Anchor anchor =
      share_policy::Scaled(requested.value_or(share_policy::DefaultAnchor(width_in_css)), zoom);
  NSRect rect = NSMakeRect(anchor.x, anchor.y, std::max(anchor.width, 1.0), std::max(anchor.height, 1.0));
  if (!view.isFlipped) {
    rect.origin.y = NSHeight(view.bounds) - rect.origin.y - rect.size.height;
  }
  NSRectEdge edge = view.isFlipped ? NSMaxYEdge : NSMinYEdge;
  switch (share_policy::EdgeFor(requested ? std::optional(anchor) : std::nullopt, NSWidth(view.bounds))) {
    case share_policy::Edge::kBelow:
      break;
    case share_policy::Edge::kLeading:
      edge = NSMinXEdge;
      break;
    case share_policy::Edge::kTrailing:
      edge = NSMaxXEdge;
      break;
  }
  return Placement{rect, edge};
}

NSArray<NSSharingService*>* ServicesFor(NSArray* items) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  NSArray<NSSharingService*>* all = [NSSharingService sharingServicesForItems:items];
  NSString* mail = [NSSharingService sharingServiceNamed:NSSharingServiceNameComposeEmail].title;
  NSString* reading = [NSSharingService sharingServiceNamed:NSSharingServiceNameAddToSafariReadingList].title;
#pragma clang diagnostic pop
  NSMutableArray<NSSharingService*>* kept = [NSMutableArray array];
  for (NSSharingService* service in all) {
    if ((mail && [service.title isEqualToString:mail]) || (reading && [service.title isEqualToString:reading])) {
      continue;
    }
    [kept addObject:service];
  }
  return kept;
}

NSArray* SampleItems() {
  return @[ [NSURL URLWithString:@"https://ardia.dev"] ];
}

std::string ServiceTitles(NSArray* items) {
  std::vector<std::string> titles;
  for (NSSharingService* service in ServicesFor(items)) {
    titles.push_back(base::SysNSStringToUTF8(service.title));
  }
  return base::JoinString(titles, "|");
}

void AppendActivityLog(std::string line) {
  base::ThreadPool::PostTask(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
      base::BindOnce(
          [](base::FilePath path, std::string line) {
            const bool written =
                base::PathExists(path) ? base::AppendToFile(path, line) : base::WriteFile(path, line);
            if (!written) {
              Trace("activation.log is not writable");
            }
          },
          DataDirectory().Append("activation.log"),
          base::SysNSStringToUTF8([[[NSISO8601DateFormatter alloc] init] stringFromDate:[NSDate date]]) + " " +
              line + "\n"));
}

void LogUnshown(ShellHostView& host, const std::string& line) {
  host.Note(line);
  AppendActivityLog(line);
}

std::string Describe(const NSRect& rect) {
  return base::SysNSStringToUTF8(NSStringFromRect(rect));
}

void ShowPicker(ShellHostView* host,
                NSArray* items,
                std::optional<share_policy::Anchor> anchor,
                std::optional<base::FilePath> file,
                std::string description,
                Done done) {
  NSView* view = ShellView(host);
  NSWindow* window = view.window;
  if (!view || !window) {
    if (file) {
      RemoveTemporary(*file);
    }
    return std::move(done).Run(true, base::Value());
  }
  const Placement placement = PlacementFor(view, anchor, ZoomOf(host->shell_contents()));
  if (BackgroundInstance()) {
    LogUnshown(*host, "share sheet (not shown): " + description + " window=#" +
                          base::NumberToString(window.windowNumber) + " anchor=" + Describe(placement.rect) +
                          " inWindow=" + Describe([view convertRect:placement.rect toView:nil]) +
                          " services=" + ServiceTitles(items));
    if (file) {
      RemoveTemporary(*file);
    }
    return std::move(done).Run(true, base::Value());
  }
  const std::uint64_t id = NextRequest();
  Request request;
  request.owner = host->window_id();
  request.delegate = [[ArdiaMacShareRequest alloc] initWithRequest:id];
  request.window = window;
  request.done = std::move(done);
  request.file = std::move(file);
  NSSharingServicePicker* picker = [[NSSharingServicePicker alloc] initWithItems:items];
  picker.delegate = request.delegate;
  request.picker = picker;
  Requests()[id] = std::move(request);
  [picker showRelativeToRect:placement.rect ofView:view preferredEdge:placement.edge];
}

struct SharedFile {
  base::FilePath path;
  bool temporary = false;
};

std::optional<SharedFile> ShareableFile(NSURL* url, const std::string& owner) {
  if (!url.isFileURL || !url.path) {
    return std::nullopt;
  }
  const std::string path = base::SysNSStringToUTF8(url.path.stringByStandardizingPath);
  if (!share_policy::CleanAbsolutePath(path)) {
    return std::nullopt;
  }
  struct stat info = {};
  if (lstat(path.c_str(), &info) != 0) {
    return std::nullopt;
  }
  if (UnderSharedImages(path)) {
    if (!InInstanceDirectory(path) || !S_ISREG(info.st_mode) || !Issued().Take(path, owner)) {
      return std::nullopt;
    }
    return SharedFile{base::FilePath(path), true};
  }
  if (!S_ISDIR(info.st_mode)) {
    return std::nullopt;
  }
  return SharedFile{base::FilePath(path), false};
}

void ShareLink(ShellHostView& caller, const base::ListValue* values, Done done) {
  const std::string url = StringAt(values, 0);
  const std::optional<std::string> title = OptionalStringAt(values, 1);
  const share_policy::UrlKind kind = share_policy::ClassifyUrl(url);
  if (kind == share_policy::UrlKind::kRefused || (title && !share_policy::ValidTitle(*title))) {
    return std::move(done).Run(
        false, Failure("ERR_SHARE_REQUEST", "Only web links, shared folders and shared images can be shared"));
  }
  NSURL* link = [NSURL URLWithString:base::SysUTF8ToNSString(url)];
  if (!link) {
    return std::move(done).Run(false, Failure("ERR_SHARE_REQUEST", "The link can't be shared"));
  }
  ShellHostView* host = TargetHost(caller, OptionalStringAt(values, 2));
  const std::optional<share_policy::Anchor> anchor = AnchorAt(values, 3);
  const std::string description = "url=" + url + " title=\"" + title.value_or("") + "\"";
  if (kind == share_policy::UrlKind::kFile) {
    std::optional<SharedFile> file = ShareableFile(link, caller.window_id());
    if (!file) {
      return std::move(done).Run(
          false, Failure("ERR_SHARE_REQUEST", "Only shared folders and images this window took can be shared from disk"));
    }
    NSURL* item = [NSURL fileURLWithPath:base::SysUTF8ToNSString(file->path.value())];
    std::optional<base::FilePath> owned = file->temporary ? std::optional(file->path) : std::nullopt;
    return ShowPicker(host, @[ item ], anchor, std::move(owned), description, std::move(done));
  }
  NSString* shown = title && !title->empty() ? base::SysUTF8ToNSString(*title) : link.host;
  NSPreviewRepresentingActivityItem* item =
      [[NSPreviewRepresentingActivityItem alloc] initWithItem:link title:shown image:nil icon:nil];
  ShowPicker(host, @[ item ], anchor, std::nullopt, description, std::move(done));
}

void ShareText(ShellHostView& caller, const base::ListValue* values, Done done) {
  const std::string text = StringAt(values, 0);
  if (!share_policy::ShareableText(text)) {
    return std::move(done).Run(true, base::Value());
  }
  ShellHostView* host = TargetHost(caller, OptionalStringAt(values, 1));
  ShowPicker(host, @[ base::SysUTF8ToNSString(text) ], AnchorAt(values, 2), std::nullopt,
             "text of " + base::NumberToString(base::UTF8ToUTF16(text).size()) + " characters", std::move(done));
}

void ShareVia(ShellHostView& caller, const base::ListValue* values, Done done) {
  const std::string service = StringAt(values, 0);
  const std::string url = StringAt(values, 1);
  const std::optional<std::string> title = OptionalStringAt(values, 2);
  if (!share_policy::ValidServiceName(service) || share_policy::ClassifyUrl(url) != share_policy::UrlKind::kWeb ||
      (title && !share_policy::ValidTitle(*title))) {
    return std::move(done).Run(false, Failure("ERR_SHARE_REQUEST", "Only web links can be shared through a service"));
  }
  NSURL* link = [NSURL URLWithString:base::SysUTF8ToNSString(url)];
  NSString* wanted = base::SysUTF8ToNSString(service);
  NSSharingService* match = nil;
  for (NSSharingService* candidate in ServicesFor(SampleItems())) {
    if ([candidate.title isEqualToString:wanted]) {
      match = candidate;
      break;
    }
  }
  ShellHostView* host = TargetHost(caller, OptionalStringAt(values, 3));
  if (!link || !match) {
    return std::move(done).Run(true, base::Value());
  }
  if (BackgroundInstance()) {
    LogUnshown(*host,
               "share via " + service + " (not performed): url=" + url + " title=\"" + title.value_or("") + "\"");
    return std::move(done).Run(true, base::Value());
  }
  const std::uint64_t id = NextRequest();
  Request request;
  request.owner = host->window_id();
  request.delegate = [[ArdiaMacShareRequest alloc] initWithRequest:id];
  request.window = ShellView(host).window;
  match.delegate = request.delegate;
  match.subject = title ? base::SysUTF8ToNSString(*title) : nil;
  Requests()[id] = std::move(request);
  [match performWithItems:@[ link ]];
  std::move(done).Run(true, base::Value());
}

void ListServices(Done done) {
  base::ListValue services;
  for (const Service& service : LinkServices()) {
    services.Append(base::DictValue().Set("title", service.title).Set("menuTitle", service.menu_title));
  }
  std::move(done).Run(true, base::Value(std::move(services)));
}

void OpenSharingSettings(ShellHostView& host, Done done) {
  if (BackgroundInstance()) {
    LogUnshown(host, "sharing settings (not opened)");
  } else if (NSURL* url = [NSURL URLWithString:@(kSharingSettings)]) {
    [[NSWorkspace sharedWorkspace] openURL:url];
  }
  std::move(done).Run(true, base::Value());
}

bool Web(const GURL& url) {
  return url.SchemeIsHTTPOrHTTPS();
}

share_policy::PageMedia MediaOf(MediaType type) {
  switch (type) {
    case MediaType::kNone:
      return share_policy::PageMedia::kNone;
    case MediaType::kImage:
      return share_policy::PageMedia::kImage;
    case MediaType::kVideo:
      return share_policy::PageMedia::kVideo;
    case MediaType::kAudio:
      return share_policy::PageMedia::kAudio;
    default:
      return share_policy::PageMedia::kOther;
  }
}

std::vector<int> Neighbours(share_policy::PageShare share) {
  switch (share) {
    case share_policy::PageShare::kText:
      return {IDC_CONTENT_CONTEXT_COPY};
    case share_policy::PageShare::kLink:
      return {IDC_CONTENT_CONTEXT_COPYLINKLOCATION, IDC_CONTENT_CONTEXT_SAVELINKAS};
    case share_policy::PageShare::kImage:
      return {IDC_CONTENT_CONTEXT_COPYIMAGELOCATION, IDC_CONTENT_CONTEXT_COPYIMAGE, IDC_CONTENT_CONTEXT_SAVEIMAGEAS};
    case share_policy::PageShare::kVideo:
    case share_policy::PageShare::kAudio:
      return {IDC_CONTENT_CONTEXT_COPYAVLOCATION, IDC_CONTENT_CONTEXT_SAVEAVAS};
    case share_policy::PageShare::kPage:
      return {IDC_PRINT, IDC_SAVE_PAGE};
  }
  return {};
}

ShellHostView* HostOfPage(content::WebContents* contents, PageBinding** binding) {
  for (ShellHostView* host : Hosts()) {
    if (PageBinding* found = host->BindingForContents(contents); found && !found->claim.empty()) {
      *binding = found;
      return host;
    }
  }
  return nullptr;
}

std::optional<base::ListValue> ShellAnchor(ShellHostView* host, content::WebContents* page, const gfx::PointF& point) {
  content::RenderWidgetHostView* page_view = page ? page->GetRenderWidgetHostView() : nullptr;
  NSView* page_ns = page_view ? page_view->GetNativeView().GetNativeNSView() : nil;
  NSView* shell = ShellView(host);
  if (!page_ns || !shell || page_ns.window != shell.window) {
    return std::nullopt;
  }
  const NSPoint local = NSMakePoint(point.x(), page_ns.isFlipped ? point.y() : NSHeight(page_ns.bounds) - point.y());
  const NSPoint in_shell = [shell convertPoint:[page_ns convertPoint:local toView:nil] fromView:nil];
  const double zoom = ZoomOf(host->shell_contents());
  const double x = in_shell.x / zoom;
  const double y = (shell.isFlipped ? in_shell.y : NSHeight(shell.bounds) - in_shell.y) / zoom;
  if (!share_policy::Finite(x) || !share_policy::Finite(y)) {
    return std::nullopt;
  }
  return base::ListValue().Append(x).Append(y).Append(1).Append(1);
}

void Deliver(content::WebContents* contents,
             base::DictValue share,
             const gfx::PointF& point,
             std::optional<base::FilePath> file) {
  PageBinding* binding = nullptr;
  ShellHostView* host = contents ? HostOfPage(contents, &binding) : nullptr;
  if (!host || !binding) {
    if (file) {
      RemoveTemporary(*file);
    }
    return;
  }
  if (file) {
    const std::string issued = StandardPath(file->value());
    if (std::optional<std::string> evicted = Issued().Issue(issued, host->window_id())) {
      RemoveTemporary(base::FilePath(*evicted));
    }
    share.Set("fileUrl",
              base::SysNSStringToUTF8([NSURL fileURLWithPath:base::SysUTF8ToNSString(issued)].absoluteString));
  }
  base::DictValue data;
  data.Set("command", "share");
  data.Set("text", "");
  data.Set("share", std::move(share));
  if (std::optional<base::ListValue> anchor = ShellAnchor(host, contents, point)) {
    data.Set("anchor", std::move(*anchor));
  }
  base::DictValue delivery = binding->Envelope("pageEvent");
  delivery.Set("event", base::DictValue().Set("name", "command").Set("data", std::move(data)));
  host->Emit("ArdiaWebView", base::NumberToString(binding->id()), base::Value(std::move(delivery)));
}

void DeliverImage(base::WeakPtr<content::WebContents> contents,
                  std::unique_ptr<ChromeRenderFrame> frame,
                  GURL source,
                  std::string title,
                  gfx::PointF point,
                  const std::vector<uint8_t>& image,
                  const gfx::Size& original_size,
                  const gfx::Size& downscaled_size,
                  const std::string& mime_type,
                  std::vector<lens::mojom::LatencyLogPtr> logs) {
  if (!contents || (image.empty() && !Web(source))) {
    return;
  }
  base::DictValue share;
  share.Set("kind", "image");
  share.Set("title", title);
  if (Web(source)) {
    share.Set("url", source.spec());
  }
  if (image.empty() || image.size() > static_cast<size_t>(kMaxSharedImageBytes)) {
    return Deliver(contents.get(), std::move(share), point, std::nullopt);
  }
  const base::FilePath path = InstanceDirectory().Append(base::Uuid::GenerateRandomV4().AsLowercaseString() + "." +
                                                         std::string(share_policy::ImageExtension(mime_type)));
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_BLOCKING},
      base::BindOnce(
          [](base::FilePath path, std::vector<uint8_t> bytes) {
            return base::CreateDirectory(path.DirName()) && base::WriteFile(path, bytes);
          },
          path, image),
      base::BindOnce(
          [](base::WeakPtr<content::WebContents> contents, base::DictValue share, gfx::PointF point,
             base::FilePath path, bool written) {
            if (!contents) {
              return RemoveTemporary(path);
            }
            Deliver(contents.get(), std::move(share), point, written ? std::optional(path) : std::nullopt);
          },
          contents, std::move(share), point, path));
}

void ShareFromMenu(content::RenderFrameHost& frame,
                   const content::ContextMenuParams& params,
                   share_policy::PageShare share) {
  content::WebContents* contents = content::WebContents::FromRenderFrameHost(&frame);
  if (!contents) {
    return;
  }
  const gfx::PointF point(params.x, params.y);
  base::DictValue item;
  item.Set("kind", share_policy::KindName(share));
  switch (share) {
    case share_policy::PageShare::kText:
      item.Set("text", base::UTF16ToUTF8(params.selection_text));
      break;
    case share_policy::PageShare::kLink:
      item.Set("url", params.link_url.spec());
      item.Set("title", base::UTF16ToUTF8(params.link_text));
      break;
    case share_policy::PageShare::kVideo:
    case share_policy::PageShare::kAudio:
      item.Set("url", params.src_url.spec());
      break;
    case share_policy::PageShare::kPage:
      item.Set("url", params.page_url.spec());
      item.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
      break;
    case share_policy::PageShare::kImage: {
      auto remote = std::make_unique<ChromeRenderFrame>();
      frame.GetRemoteAssociatedInterfaces()->GetInterface(remote.get());
      ChromeRenderFrame* requester = remote.get();
      (*requester)->RequestImageForContextNode(
          0, gfx::Size(kLargestSharedImage, kLargestSharedImage), chrome::mojom::ImageFormat::ORIGINAL,
          chrome::mojom::kDefaultQuality,
          base::BindOnce(&DeliverImage, contents->GetWeakPtr(), std::move(remote), params.src_url,
                         base::UTF16ToUTF8(!params.alt_text.empty() ? params.alt_text : params.title_text), point));
      return;
    }
  }
  Deliver(contents, std::move(item), point, std::nullopt);
}

class PageShareObserver : public RenderViewContextMenuObserver {
 public:
  PageShareObserver(content::GlobalRenderFrameHostId frame,
                    content::ContextMenuParams params,
                    std::vector<share_policy::PageShare> shares)
      : frame_(frame), params_(std::move(params)), shares_(std::move(shares)) {}

  bool IsCommandIdSupported(int command_id) override { return Index(command_id).has_value(); }
  bool IsCommandIdEnabled(int command_id) override { return Index(command_id).has_value(); }

  void ExecuteCommand(int command_id) override {
    const std::optional<size_t> index = Index(command_id);
    content::RenderFrameHost* frame = content::RenderFrameHost::FromID(frame_);
    if (index && frame) {
      ShareFromMenu(*frame, params_, shares_[*index]);
    }
  }

 private:
  std::optional<size_t> Index(int command_id) const {
    if (command_id < kShareFirst) {
      return std::nullopt;
    }
    const size_t index = static_cast<size_t>(command_id - kShareFirst);
    return index < shares_.size() ? std::optional(index) : std::nullopt;
  }

  content::GlobalRenderFrameHostId frame_;
  content::ContextMenuParams params_;
  std::vector<share_policy::PageShare> shares_;
};

share_policy::KeyedOwner<const RenderViewContextMenuBase*, PageShareObserver>& MenuObservers() {
  static base::NoDestructor<share_policy::KeyedOwner<const RenderViewContextMenuBase*, PageShareObserver>> observers;
  return *observers;
}

RenderViewContextMenuObserver* PageMenuObserver(RenderViewContextMenuBase* menu, ui::SimpleMenuModel* model) {
  content::RenderFrameHost* frame = menu ? menu->GetRenderFrameHost() : nullptr;
  content::WebContents* contents = menu ? menu->GetWebContents() : nullptr;
  PageBinding* binding = nullptr;
  if (!frame || !contents || !model || !HostOfPage(contents, &binding)) {
    return nullptr;
  }
  const content::ContextMenuParams& params = menu->params();
  share_policy::PageShareInput input;
  input.editable = params.is_editable;
  input.link_is_web = Web(params.link_url);
  input.has_selection = !params.selection_text.empty();
  input.selection_is_link_text =
      base::CollapseWhitespace(params.selection_text, true) == base::CollapseWhitespace(params.link_text, true);
  input.media = MediaOf(params.media_type);
  input.has_image_contents = params.has_image_contents;
  input.source_is_web = Web(params.src_url);
  input.page_is_web = Web(params.page_url);
  std::vector<share_policy::PageShare> shares = share_policy::SharesFor(input);
  if (shares.empty() || shares.size() > share_policy::kMaxPageShares) {
    return nullptr;
  }
  for (size_t index = 0; index < shares.size(); ++index) {
    size_t at = model->GetItemCount();
    for (int neighbour : Neighbours(shares[index])) {
      if (std::optional<size_t> found = model->GetIndexOfCommandId(neighbour)) {
        at = *found + 1;
        while (at < model->GetItemCount() && model->GetTypeAt(at) != ui::MenuModel::TYPE_SEPARATOR) {
          ++at;
        }
        break;
      }
    }
    model->InsertItemAt(at, kShareFirst + static_cast<int>(index),
                        base::UTF8ToUTF16(share_policy::ShareTitle(shares[index], shares.size() == 1)));
  }
  return MenuObservers().Attach(
      menu, std::make_unique<PageShareObserver>(frame->GetGlobalId(), params, std::move(shares)));
}

void PageMenuDestroyed(RenderViewContextMenuBase* menu) {
  MenuObservers().Release(menu);
}

void SweepStaleInstances(base::FilePath root, base::FilePath own) {
  base::FileEnumerator entries(root, false, base::FileEnumerator::FILES | base::FileEnumerator::DIRECTORIES);
  for (base::FilePath entry = entries.Next(); !entry.empty(); entry = entries.Next()) {
    if (entry == own) {
      continue;
    }
    if (!entries.GetInfo().IsDirectory()) {
      base::DeleteFile(entry);
      continue;
    }
    const std::optional<long> pid = share_policy::InstancePid(entry.BaseName().value());
    if (!pid || (kill(static_cast<pid_t>(*pid), 0) != 0 && errno == ESRCH)) {
      base::DeletePathRecursively(entry);
    }
  }
}

}

void PickerChose(std::uint64_t id, NSSharingServicePicker* picker, bool cancelled) {
  auto found = Requests().find(id);
  if (found == Requests().end() || found->second.picker != picker) {
    return;
  }
  found->second.picker = nil;
  if (cancelled) {
    return EndRequest(id);
  }
  Settle(found->second);
}

void ServiceFinished(std::uint64_t id) {
  EndRequest(id);
}

NSWindow* SourceWindow(std::uint64_t id) {
  auto found = Requests().find(id);
  return found == Requests().end() ? nil : found->second.window;
}

std::vector<Service> LinkServices() {
  std::vector<Service> services;
  for (NSSharingService* service in ServicesFor(SampleItems())) {
    const std::string title = base::SysNSStringToUTF8(service.title);
    if (share_policy::ValidServiceName(title)) {
      services.push_back(Service{title, base::SysNSStringToUTF8(service.menuItemTitle ?: service.title)});
    }
  }
  return services;
}

void Retire(const std::string& owner) {
  std::vector<std::uint64_t> retired;
  for (auto& [id, request] : Requests()) {
    if (request.owner == owner) {
      retired.push_back(id);
    }
  }
  for (std::uint64_t id : retired) {
    auto found = Requests().find(id);
    if (found == Requests().end()) {
      continue;
    }
    NSSharingServicePicker* picker = found->second.picker;
    found->second.picker = nil;
    [picker close];
    EndRequest(id);
  }
  for (const std::string& path : Issued().ReleaseOwner(owner)) {
    RemoveTemporary(base::FilePath(path));
  }
}

bool Handles(std::string_view method) {
  return std::ranges::find(kCapabilities, method) != std::end(kCapabilities);
}

void AppendCapabilities(base::ListValue& capabilities) {
  for (std::string_view capability : kCapabilities) {
    capabilities.Append(capability);
  }
}

void Invoke(ShellHostView& host, const std::string& method, const base::ListValue* values, ShellHostView::Done done) {
  if (method == "ArdiaApp.share") {
    return ShareLink(host, values, std::move(done));
  }
  if (method == "ArdiaApp.shareText") {
    return ShareText(host, values, std::move(done));
  }
  if (method == "ArdiaApp.shareVia") {
    return ShareVia(host, values, std::move(done));
  }
  if (method == "ArdiaApp.shareServices") {
    return ListServices(std::move(done));
  }
  if (method == "ArdiaApp.openSharingSettings") {
    return OpenSharingSettings(host, std::move(done));
  }
  std::move(done).Run(false, Failure("ERR_UNKNOWN_CALL", "Unknown share call"));
}

void InstallPageMenu() {
  g_ardia_mac_page_menu_observer = &PageMenuObserver;
  g_ardia_mac_page_menu_destroyed = &PageMenuDestroyed;
  base::ThreadPool::PostTask(FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
                             base::BindOnce(&SweepStaleInstances, SharedImagesRoot(), InstanceDirectory()));
}

}
