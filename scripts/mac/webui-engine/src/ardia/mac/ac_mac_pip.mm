#include "ardia/mac/ac_mac_pip.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "ardia/mac/ac_mac_shell_host.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "cc/layers/deadline_policy.h"
#include "chrome/browser/picture_in_picture/auto_picture_in_picture_tab_helper.h"
#include "chrome/browser/picture_in_picture/picture_in_picture_window_manager.h"
#include "chrome/browser/ui/views/overlay/video_overlay_window_views.h"
#include "components/viz/common/frame_timing_details.h"
#include "content/public/browser/video_picture_in_picture_window_controller.h"
#include "content/public/browser/web_contents.h"
#include "media/base/video_util.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/compositor/compositor.h"
#include "ui/compositor/layer.h"
#include "ui/compositor/layer_animation_element.h"
#include "ui/compositor/layer_animator.h"
#include "ui/compositor/layer_solid_color.h"
#include "ui/compositor/layer_surface.h"
#include "ui/compositor/scoped_layer_animation_settings.h"
#include "ui/gfx/animation/tween.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/views/widget/widget.h"

extern std::unique_ptr<content::VideoOverlayWindow> (*g_ardia_mac_video_overlay)(
    content::VideoPictureInPictureWindowController* controller);
extern bool g_ardia_auto_picture_in_picture_off;

namespace ardia_mac {

namespace pip = pip_policy;

namespace {

uint64_t NextGeneration() {
  static uint64_t generation = 0;
  return ++generation;
}

std::unique_ptr<content::VideoOverlayWindow> CreatePlayer(
    content::VideoPictureInPictureWindowController* controller) {
  if (Hosts().empty()) {
    return nullptr;
  }
  return std::make_unique<PipPlayer>(controller);
}

pip::Intent IntentFor(content::WebContents* contents) {
  auto* helper = contents ? AutoPictureInPictureTabHelper::FromWebContents(contents) : nullptr;
  if (helper && (helper->AreAutoPictureInPicturePreconditionsMet() || helper->IsInAutoPictureInPicture())) {
    return pip::Intent::kAutomatic;
  }
  return pip::Intent::kExplicit;
}

base::TimeDelta Milliseconds(double ms) {
  return base::Milliseconds(ms);
}

}

PipPlayer::PipPlayer(content::VideoPictureInPictureWindowController* controller) : controller_(controller) {}

PipPlayer::~PipPlayer() {
  handoff_timer_.Stop();
  if (PipPresenter* presenter = presenter_.get()) {
    presenter_.reset();
    presenter->HidePlayer(this, base::TimeDelta());
  }
}

content::WebContents* PipPlayer::source() const {
  return controller_ ? controller_->GetWebContents() : nullptr;
}

bool PipPlayer::IsActive() const {
  return Windowed() && window_->IsActive();
}

void PipPlayer::Close() {
  handoff_timer_.Stop();
  ReleasePresenter(base::TimeDelta());
  mode_ = Mode::kIdle;
  visible_ = false;
  if (window_) {
    window_->Close();
  }
}

void PipPlayer::ShowInactive() {
  generation_ = NextGeneration();
  hide_fade_ = Milliseconds(pip::kBackToTabFadeMs);
  content::WebContents* contents = source();
  const pip::Intent intent = IntentFor(contents);
  if (intent == pip::Intent::kAutomatic && Windowed() && IsVisible()) {
    return;
  }
  PipPresenter* presenter = intent == pip::Intent::kAutomatic ? PipPresenter::Find(contents) : nullptr;
  switch (pip::PresentationFor(intent, presenter != nullptr)) {
    case pip::Presentation::kInWindow:
      return EnterInWindow(presenter);
    case pip::Presentation::kWindow:
      return EnterWindow(std::nullopt);
    case pip::Presentation::kDeclined:
      handoff_timer_.Stop();
      ReleasePresenter(base::TimeDelta());
      if (window_ && window_->IsVisible()) {
        window_->Hide();
      }
      mode_ = Mode::kDeclined;
      visible_ = true;
      EndSessionSoon();
      return;
  }
}

void PipPlayer::EnterInWindow(PipPresenter* presenter) {
  handoff_timer_.Stop();
  if (window_ && window_->IsVisible()) {
    window_->Hide();
  }
  PipPresenter* previous = presenter_.get();
  if (previous && previous != presenter) {
    presenter_.reset();
    previous->HidePlayer(this, base::TimeDelta());
  }
  presenter_ = presenter->GetWeakPtr();
  presented_generation_ = generation_;
  mode_ = Mode::kInWindow;
  visible_ = true;
  if (bounds_.IsEmpty()) {
    bounds_ = presenter->DefaultPlayerScreenBounds(natural_size_);
  }
  presenter->ShowPlayer(this);
}

void PipPlayer::EnterWindow(std::optional<gfx::Rect> screen_bounds) {
  const bool handoff = mode_ == Mode::kInWindow && presenter_;
  if (!window_) {
    window_ = VideoOverlayWindowViews::Create(controller_);
  }
  ReplayInto(window_.get());
  if (screen_bounds && !screen_bounds->IsEmpty()) {
    window_->SetBounds(*screen_bounds);
  }
  mode_ = Mode::kWindow;
  visible_ = true;
  if (BackgroundInstance()) {
    Trace("background instance: picture in picture window kept ordered out");
  } else {
    window_->ShowInactive();
  }
  if (!handoff) {
    return ReleasePresenter(base::TimeDelta());
  }
  const uint64_t generation = generation_;
  handoff_timer_.Start(FROM_HERE, Milliseconds(pip::kHandoffDeadlineMs),
                       base::BindOnce(&PipPlayer::FinishHandoff, weak_factory_.GetWeakPtr(), generation));
  if (ui::Compositor* compositor = window_->GetCompositor()) {
    compositor->RequestSuccessfulPresentationTimeForNextFrame(base::BindOnce(
        [](base::WeakPtr<PipPlayer> player, uint64_t generation, const viz::FrameTimingDetails&) {
          if (player) {
            player->FinishHandoff(generation);
          }
        },
        weak_factory_.GetWeakPtr(), generation));
  }
}

void PipPlayer::FinishHandoff(uint64_t generation) {
  if (generation != generation_ || mode_ != Mode::kWindow) {
    return;
  }
  handoff_timer_.Stop();
  ReleasePresenter(base::TimeDelta());
}

void PipPlayer::ReplayInto(VideoOverlayWindowViews* window) {
  if (!natural_size_.IsEmpty()) {
    window->UpdateNaturalSize(natural_size_);
  }
  window->SetPlaybackState(playback_state_);
  window->SetPlayPauseButtonVisibility(play_pause_visible_);
  window->SetSkipAdButtonVisibility(skip_ad_visible_);
  window->SetNextTrackButtonVisibility(next_track_visible_);
  window->SetPreviousTrackButtonVisibility(previous_track_visible_);
  window->SetHidePictureInPictureButtonVisibility(hide_button_visible_);
  window->SetMicrophoneMuted(microphone_muted_);
  window->SetCameraState(camera_on_);
  window->SetMediaMuted(media_muted_);
  window->SetToggleMicrophoneButtonVisibility(toggle_microphone_visible_);
  window->SetToggleCameraButtonVisibility(toggle_camera_visible_);
  window->SetHangUpButtonVisibility(hang_up_visible_);
  window->SetNextSlideButtonVisibility(next_slide_visible_);
  window->SetPreviousSlideButtonVisibility(previous_slide_visible_);
  if (position_) {
    window->SetMediaPosition(*position_);
  }
  window->SetSourceTitle(source_title_);
  window->SetFaviconImages(favicon_images_);
  window->SetPlaybackControlsVisibility(playback_controls_visible_);
  if (immersive_options_) {
    window->SetImmersiveVideoOptions(*immersive_options_);
  }
  if (surface_id_.is_valid()) {
    window->SetSurfaceId(surface_id_);
  }
}

void PipPlayer::Hide() {
  handoff_timer_.Stop();
  const Mode previous = mode_;
  mode_ = Mode::kIdle;
  visible_ = false;
  const base::TimeDelta fade = std::exchange(hide_fade_, Milliseconds(pip::kBackToTabFadeMs));
  if (previous == Mode::kWindow && window_) {
    window_->Hide();
  }
  ReleasePresenter(previous == Mode::kInWindow ? fade : base::TimeDelta());
}

bool PipPlayer::IsVisible() const {
  if (mode_ == Mode::kWindow) {
    return window_ && window_->IsVisible();
  }
  return visible_;
}

gfx::Rect PipPlayer::GetBounds() {
  return Windowed() ? window_->GetBounds() : bounds_;
}

void PipPlayer::Changed() {
  if (PipPresenter* presenter = presenter_.get()) {
    presenter->PlayerChanged(this);
  }
}

void PipPlayer::UpdateNaturalSize(const gfx::Size& natural_size) {
  natural_size_ = natural_size;
  if (Windowed()) {
    window_->UpdateNaturalSize(natural_size);
  }
  Changed();
}

void PipPlayer::SetPlaybackState(PlaybackState playback_state) {
  playback_state_ = playback_state;
  if (Windowed()) {
    window_->SetPlaybackState(playback_state);
  }
  Changed();
}

void PipPlayer::SetPlayPauseButtonVisibility(bool is_visible) {
  play_pause_visible_ = is_visible;
  if (Windowed()) {
    window_->SetPlayPauseButtonVisibility(is_visible);
  }
  Changed();
}

void PipPlayer::SetSkipAdButtonVisibility(bool is_visible) {
  skip_ad_visible_ = is_visible;
  if (Windowed()) {
    window_->SetSkipAdButtonVisibility(is_visible);
  }
}

void PipPlayer::SetNextTrackButtonVisibility(bool is_visible) {
  next_track_visible_ = is_visible;
  if (Windowed()) {
    window_->SetNextTrackButtonVisibility(is_visible);
  }
}

void PipPlayer::SetPreviousTrackButtonVisibility(bool is_visible) {
  previous_track_visible_ = is_visible;
  if (Windowed()) {
    window_->SetPreviousTrackButtonVisibility(is_visible);
  }
}

void PipPlayer::SetHidePictureInPictureButtonVisibility(bool is_visible) {
  hide_button_visible_ = is_visible;
  if (Windowed()) {
    window_->SetHidePictureInPictureButtonVisibility(is_visible);
  }
}

void PipPlayer::SetMicrophoneMuted(bool muted) {
  microphone_muted_ = muted;
  if (Windowed()) {
    window_->SetMicrophoneMuted(muted);
  }
}

void PipPlayer::SetCameraState(bool turned_on) {
  camera_on_ = turned_on;
  if (Windowed()) {
    window_->SetCameraState(turned_on);
  }
}

void PipPlayer::SetMediaMuted(bool muted) {
  media_muted_ = muted;
  if (Windowed()) {
    window_->SetMediaMuted(muted);
  }
}

void PipPlayer::SetToggleMicrophoneButtonVisibility(bool is_visible) {
  toggle_microphone_visible_ = is_visible;
  if (Windowed()) {
    window_->SetToggleMicrophoneButtonVisibility(is_visible);
  }
}

void PipPlayer::SetToggleCameraButtonVisibility(bool is_visible) {
  toggle_camera_visible_ = is_visible;
  if (Windowed()) {
    window_->SetToggleCameraButtonVisibility(is_visible);
  }
}

void PipPlayer::SetHangUpButtonVisibility(bool is_visible) {
  hang_up_visible_ = is_visible;
  if (Windowed()) {
    window_->SetHangUpButtonVisibility(is_visible);
  }
}

void PipPlayer::SetNextSlideButtonVisibility(bool is_visible) {
  next_slide_visible_ = is_visible;
  if (Windowed()) {
    window_->SetNextSlideButtonVisibility(is_visible);
  }
}

void PipPlayer::SetPreviousSlideButtonVisibility(bool is_visible) {
  previous_slide_visible_ = is_visible;
  if (Windowed()) {
    window_->SetPreviousSlideButtonVisibility(is_visible);
  }
}

void PipPlayer::SetMediaPosition(const media_session::MediaPosition& position) {
  position_ = position;
  if (Windowed()) {
    window_->SetMediaPosition(position);
  }
  Changed();
}

void PipPlayer::SetSourceTitle(const std::u16string& source_title) {
  source_title_ = source_title;
  if (Windowed()) {
    window_->SetSourceTitle(source_title);
  }
  Changed();
}

void PipPlayer::SetFaviconImages(const std::vector<media_session::MediaImage>& images) {
  favicon_images_ = images;
  if (Windowed()) {
    window_->SetFaviconImages(images);
  }
}

void PipPlayer::SetSurfaceId(const viz::SurfaceId& surface_id) {
  surface_id_ = surface_id;
  if (Windowed()) {
    window_->SetSurfaceId(surface_id);
  }
  if (PipPresenter* presenter = presenter_.get()) {
    presenter->PlayerSurfaceChanged(this);
  }
}

void PipPlayer::SetPlaybackControlsVisibility(bool is_visible) {
  playback_controls_visible_ = is_visible;
  if (Windowed()) {
    window_->SetPlaybackControlsVisibility(is_visible);
  }
}

void PipPlayer::SetImmersiveVideoOptions(const content::ImmersiveOptions& options) {
  immersive_options_ = options;
  if (Windowed()) {
    window_->SetImmersiveVideoOptions(options);
  }
}

void PipPlayer::SetInWindowScreenBounds(const gfx::Rect& bounds) {
  if (mode_ != Mode::kInWindow || bounds.IsEmpty()) {
    return;
  }
  const bool resized = bounds.size() != bounds_.size();
  bounds_ = bounds;
  if (resized && controller_) {
    controller_->UpdateLayerBounds();
  }
}

void PipPlayer::TogglePlayPause() {
  if (mode_ != Mode::kInWindow || !controller_) {
    return;
  }
  playback_state_ = controller_->TogglePlayPause() ? kPlaying : kPaused;
  Changed();
}

void PipPlayer::SeekTo(double seconds) {
  if (mode_ != Mode::kInWindow || !controller_) {
    return;
  }
  std::optional<double> duration;
  if (position_ && !position_->duration().is_max() && position_->duration().is_positive()) {
    duration = position_->duration().InSecondsF();
  }
  controller_->SeekTo(base::Seconds(pip::ClampSeek(seconds, duration)));
}

void PipPlayer::SeekBy(double seconds) {
  if (position_) {
    SeekTo(position_->GetPosition().InSecondsF() + seconds);
  }
}

bool PipPlayer::CurrentPictureInPicture() const {
  PictureInPictureWindowManager* manager = PictureInPictureWindowManager::GetInstance();
  return source() && manager->GetWebContents() == source() && !manager->GetChildWebContents();
}

void PipPlayer::BackToTab() {
  if (mode_ != Mode::kInWindow || !CurrentPictureInPicture()) {
    return;
  }
  hide_fade_ = Milliseconds(pip::kBackToTabFadeMs);
  PictureInPictureWindowManager::GetInstance()->ExitPictureInPictureViaWindowUi(
      PictureInPictureWindowManager::UiBehavior::kCloseWindowAndFocusOpener);
}

void PipPlayer::CloseFromPlayer() {
  if (mode_ != Mode::kInWindow || !CurrentPictureInPicture()) {
    return;
  }
  hide_fade_ = Milliseconds(pip::kCloseFadeMs);
  PictureInPictureWindowManager::GetInstance()->ExitPictureInPictureViaWindowUi(
      PictureInPictureWindowManager::UiBehavior::kCloseWindowOnly);
}

void PipPlayer::PopOut(std::optional<gfx::Rect> screen_bounds) {
  if (mode_ != Mode::kInWindow || !controller_) {
    return;
  }
  EnterWindow(screen_bounds);
  if (controller_ && IsVisible()) {
    controller_->UpdateLayerBounds();
  }
}

void PipPlayer::PresenterGone(PipPresenter* presenter) {
  if (presenter_.get() != presenter) {
    return;
  }
  presenter_.reset();
  if (mode_ == Mode::kInWindow) {
    EndSessionSoon();
  }
}

void PipPlayer::ReleasePresenter(base::TimeDelta fade) {
  if (PipPresenter* presenter = presenter_.get()) {
    presenter_.reset();
    presenter->HidePlayer(this, fade);
  }
}

void PipPlayer::EndSessionSoon() {
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&PipPlayer::EndSession, weak_factory_.GetWeakPtr(), generation_));
}

void PipPlayer::EndSession(uint64_t generation) {
  if (generation != generation_ || !visible_ || (mode_ != Mode::kInWindow && mode_ != Mode::kDeclined)) {
    return;
  }
  if (CurrentPictureInPicture()) {
    PictureInPictureWindowManager::GetInstance()->ExitPictureInPicture();
    return;
  }
  if (controller_) {
    controller_->Close(false);
  }
}

PipPlayerView::PipPlayerView() {
  SetPaintToLayer(ui::LAYER_SOLID_COLOR);
  layer()->AsSolidColor()->SetColor(SkColors::kBlack);
  layer()->SetRoundedCornerRadius(gfx::RoundedCornersF(kCornerRadius));
  layer()->SetIsFastRoundedCorner(true);
  layer()->SetMasksToBounds(true);
  auto video = std::make_unique<views::View>();
  video->SetPaintToLayer(ui::LAYER_SURFACE);
  video->layer()->AsSurface()->SetFallbackBackgroundColor(SkColors::kBlack);
  video_ = AddChildView(std::move(video));
}

PipPlayerView::~PipPlayerView() {
  Unregister();
}

void PipPlayerView::SetSurface(const viz::SurfaceId& surface_id) {
  if (!surface_id.is_valid()) {
    return;
  }
  surface_id_ = surface_id;
  Register();
  LayoutVideo();
  video_->layer()->AsSurface()->SetShowSurface(surface_id_, video_->size(),
                                               cc::DeadlinePolicy::UseDefaultDeadline(), true);
}

void PipPlayerView::SetNaturalSize(const gfx::Size& natural_size) {
  if (natural_size_ == natural_size) {
    return;
  }
  natural_size_ = natural_size;
  LayoutVideo();
}

void PipPlayerView::Reveal() {
  fade_timer_.Stop();
  layer()->GetAnimator()->StopAnimatingProperty(ui::LayerAnimationElement::OPACITY);
  layer()->SetOpacity(1.0f);
}

void PipPlayerView::FadeOut(base::TimeDelta fade, base::OnceClosure done) {
  if (!fade.is_positive()) {
    fade_timer_.Stop();
    return std::move(done).Run();
  }
  ui::ScopedLayerAnimationSettings animation(layer()->GetAnimator());
  animation.SetTransitionDuration(fade);
  animation.SetTweenType(gfx::Tween::EASE_OUT);
  animation.SetPreemptionStrategy(ui::LayerAnimator::IMMEDIATELY_ANIMATE_TO_NEW_TARGET);
  layer()->SetOpacity(0.0f);
  fade_timer_.Start(FROM_HERE, fade, std::move(done));
}

void PipPlayerView::OnBoundsChanged(const gfx::Rect& previous_bounds) {
  LayoutVideo();
}

void PipPlayerView::AddedToWidget() {
  Register();
}

void PipPlayerView::RemovedFromWidget() {
  Unregister();
}

bool PipPlayerView::GetCanProcessEventsWithinSubtree() const {
  return false;
}

void PipPlayerView::Register() {
  if (!surface_id_.is_valid() || !GetWidget()) {
    return;
  }
  ui::Compositor* compositor = GetWidget()->GetCompositor();
  if (!compositor) {
    return;
  }
  if (compositor_ == compositor && registered_ && *registered_ == surface_id_.frame_sink_id()) {
    return;
  }
  Unregister();
  compositor->AddChildFrameSink(surface_id_.frame_sink_id());
  compositor->AddObserver(this);
  compositor_ = compositor;
  registered_ = surface_id_.frame_sink_id();
}

void PipPlayerView::Unregister() {
  if (!compositor_) {
    return;
  }
  ui::Compositor* compositor = std::exchange(compositor_, nullptr);
  compositor->RemoveObserver(this);
  if (registered_) {
    compositor->RemoveChildFrameSink(*registered_);
    registered_.reset();
  }
}

void PipPlayerView::OnCompositingShuttingDown(ui::Compositor* compositor) {
  if (compositor == compositor_) {
    Unregister();
  }
}

void PipPlayerView::LayoutVideo() {
  gfx::Rect video = GetLocalBounds();
  if (!natural_size_.IsEmpty() && !video.IsEmpty()) {
    const gfx::Rect letterbox = media::ComputeLetterboxRegion(video, natural_size_);
    if (!letterbox.IsEmpty()) {
      video = letterbox;
    }
  }
  video_->SetBoundsRect(video);
  if (surface_id_.is_valid()) {
    video_->layer()->AsSurface()->SetSurfaceSize(video.size());
  }
}

BEGIN_METADATA(PipPlayerView)
END_METADATA

PipPresenter::PipPresenter(ShellHostView* host) : host_(host) {
  if (!g_ardia_mac_video_overlay) {
    g_ardia_mac_video_overlay = &CreatePlayer;
  }
}

PipPresenter::~PipPresenter() {
  ReleasePlayer();
  weak_factory_.InvalidateWeakPtrs();
}

bool PipPresenter::Handles(std::string_view method) {
  return std::ranges::find(pip::kPipMethods, method) != std::end(pip::kPipMethods);
}

bool PipPresenter::HandlesEngineCall(std::string_view name) {
  return name == pip::kAutoPipCall;
}

void PipPresenter::AppendCapabilities(base::ListValue& capabilities) {
  for (std::string_view method : pip::kPipMethods) {
    capabilities.Append(method);
  }
  capabilities.Append(pip::kAutoPipCall);
}

PipPresenter* PipPresenter::Find(content::WebContents* source) {
  for (ShellHostView* host : Hosts()) {
    PipPresenter* presenter = host->pip();
    if (presenter && presenter->PresentsPlayerFor(source)) {
      return presenter;
    }
  }
  return nullptr;
}

bool PipPresenter::PresentsPlayerFor(content::WebContents* source) const {
  return pip::Presents(attached_generation_.has_value(), attached_generation_.value_or(0),
                       host_->renderer_generation_, source && host_->BindingForContents(source));
}

void PipPresenter::EngineCall(const std::string& name, const base::Value* args, Done done) {
  std::optional<base::Value> parsed = args && args->is_string()
                                          ? base::JSONReader::Read(args->GetString(), base::JSON_PARSE_RFC, 4)
                                          : std::nullopt;
  const std::optional<bool> enabled =
      parsed && parsed->is_dict() && parsed->GetDict().size() == 1 ? parsed->GetDict().FindBool("enabled")
                                                                   : std::nullopt;
  if (!enabled) {
    return std::move(done).Run(false, Failure("ERR_ENGINE", "A boolean auto-PiP setting is required"));
  }
  g_ardia_auto_picture_in_picture_off = !*enabled;
  if (!*enabled) {
    for (ShellHostView* host : Hosts()) {
      PipPresenter* presenter = host->pip();
      if (presenter && presenter->player_) {
        presenter->player_->CloseFromPlayer();
      }
    }
  }
  std::move(done).Run(true, base::Value("null"));
}

void PipPresenter::Invoke(const std::string& method, const base::DictValue& args, Done done) {
  if (method == "pip.attach") {
    attached_generation_ = host_->renderer_generation_;
    if (player_) {
      SendPlayerEvent(*player_);
    }
    return std::move(done).Run(true, base::Value());
  }
  if (!pip::PlayerMatches(args.FindDouble("player"), player_ ? player_->presented_generation() : 0)) {
    return std::move(done).Run(true, base::Value(false));
  }
  if (method == "pip.viewport") {
    return Viewport(args, std::move(done));
  }
  Command(args, std::move(done));
}

void PipPresenter::Viewport(const base::DictValue& args, Done done) {
  const base::DictValue* rect = args.FindDict("rect");
  const std::optional<pip::Box> box =
      rect ? pip::PlayerBox(rect->FindDouble("x").value_or(NAN), rect->FindDouble("y").value_or(NAN),
                            rect->FindDouble("width").value_or(NAN), rect->FindDouble("height").value_or(NAN),
                            host_->ShellZoom(), host_->width(), host_->height())
           : std::nullopt;
  if (!box) {
    return std::move(done).Run(false, Failure("ERR_PIP_REQUEST", "A finite player rectangle is required"));
  }
  if (!player_view_) {
    return std::move(done).Run(true, base::Value(false));
  }
  const gfx::Rect bounds(box->x, box->y, box->width, box->height);
  const bool visible = args.FindBool("visible").value_or(true) && !bounds.IsEmpty();
  player_view_->SetBoundsRect(bounds);
  player_view_->SetVisible(visible);
  if (visible) {
    gfx::Rect screen = bounds;
    views::View::ConvertRectToScreen(host_, &screen);
    player_->SetInWindowScreenBounds(screen);
  }
  std::move(done).Run(true, base::Value(true));
}

void PipPresenter::Command(const base::DictValue& args, Done done) {
  const std::string* name = args.FindString("action");
  const std::optional<pip::Action> action = name ? pip::ParseAction(*name) : std::nullopt;
  if (!action) {
    return std::move(done).Run(false, Failure("ERR_PIP_REQUEST", "Unknown picture in picture action"));
  }
  base::WeakPtr<PipPlayer> player = player_;
  switch (*action) {
    case pip::Action::kTogglePlayPause:
      player->TogglePlayPause();
      break;
    case pip::Action::kSeekTo:
    case pip::Action::kSeekBy: {
      const double seconds = args.FindDouble("seconds").value_or(NAN);
      if (!pip::ValidSeekSeconds(seconds)) {
        return std::move(done).Run(false, Failure("ERR_PIP_REQUEST", "A finite seek time is required"));
      }
      if (*action == pip::Action::kSeekTo) {
        player->SeekTo(seconds);
      } else {
        player->SeekBy(seconds);
      }
      break;
    }
    case pip::Action::kBackToTab:
      player->BackToTab();
      break;
    case pip::Action::kClose:
      player->CloseFromPlayer();
      break;
    case pip::Action::kPopOut: {
      std::optional<gfx::Rect> screen;
      if (player_view_) {
        gfx::Rect rect = player_view_->bounds();
        views::View::ConvertRectToScreen(host_, &rect);
        const base::DictValue* at = args.FindDict("at");
        const base::DictValue* grab = args.FindDict("grab");
        const double at_x = at ? at->FindDouble("x").value_or(NAN) : NAN;
        const double at_y = at ? at->FindDouble("y").value_or(NAN) : NAN;
        const double grab_x = grab ? grab->FindDouble("x").value_or(NAN) : NAN;
        const double grab_y = grab ? grab->FindDouble("y").value_or(NAN) : NAN;
        const double scale = host_->ShellZoom();
        const std::optional<int> x = pip::PopOutCoordinate(at_x, grab_x, scale);
        const std::optional<int> y = pip::PopOutCoordinate(at_y, grab_y, scale);
        if (x && y) {
          rect.set_origin(gfx::Point(*x, *y));
        }
        screen = rect;
      }
      player->PopOut(screen);
      break;
    }
  }
  std::move(done).Run(true, base::Value(true));
}

void PipPresenter::ShowPlayer(PipPlayer* player) {
  PipPlayer* previous = player_.get();
  if (previous && previous != player) {
    player_.reset();
    previous->PresenterGone(this);
  }
  player_ = player->GetWeakPtr();
  if (!player_view_) {
    player_view_ = host_->AddChildViewAt(std::make_unique<PipPlayerView>(), 0);
  }
  player_view_owner_ = player->presented_generation();
  player_view_->SetVisible(false);
  player_view_->Reveal();
  player_view_->SetNaturalSize(player->natural_size());
  player_view_->SetSurface(player->surface_id());
  host_->Restack();
  SendPlayerEvent(*player);
}

void PipPresenter::PlayerChanged(PipPlayer* player) {
  if (player_.get() != player) {
    return;
  }
  if (player_view_) {
    player_view_->SetNaturalSize(player->natural_size());
  }
  SendPlayerEvent(*player);
}

void PipPresenter::PlayerSurfaceChanged(PipPlayer* player) {
  if (player_.get() == player && player_view_) {
    player_view_->SetSurface(player->surface_id());
  }
}

void PipPresenter::SendLeaving(uint64_t owner, base::TimeDelta fade) {
  host_->Emit("ArdiaPip", "player",
              base::Value(base::DictValue()
                              .Set("player", static_cast<double>(owner))
                              .Set("active", false)
                              .Set("fade", fade.InMillisecondsF())));
}

void PipPresenter::HidePlayer(PipPlayer* player, base::TimeDelta fade) {
  if (player_.get() != player) {
    return;
  }
  player_.reset();
  const uint64_t owner = player->presented_generation();
  SendLeaving(owner, fade);
  if (!player_view_ || player_view_owner_ != owner) {
    return;
  }
  player_view_->FadeOut(fade, base::BindOnce(
                                  [](base::WeakPtr<PipPresenter> presenter, uint64_t owner) {
                                    if (!presenter) {
                                      return;
                                    }
                                    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
                                        FROM_HERE,
                                        base::BindOnce(&PipPresenter::DropPlayerView, presenter, owner));
                                  },
                                  GetWeakPtr(), owner));
}

void PipPresenter::DropPlayerView(uint64_t owner) {
  if (!player_view_ || player_ || player_view_owner_ != owner) {
    return;
  }
  host_->RemoveChildViewT(std::exchange(player_view_, nullptr).get());
}

gfx::Rect PipPresenter::DefaultPlayerScreenBounds(const gfx::Size& natural_size) const {
  const pip::Box box =
      pip::DefaultPlayerBox(host_->width(), host_->height(), natural_size.width(), natural_size.height());
  gfx::Rect rect(box.x, box.y, box.width, box.height);
  views::View::ConvertRectToScreen(host_, &rect);
  return rect;
}

void PipPresenter::ReleasePlayer() {
  base::WeakPtr<PipPlayer> player = player_;
  player_.reset();
  if (player) {
    SendLeaving(player->presented_generation(), base::TimeDelta());
  }
  player_view_owner_ = 0;
  if (player_view_) {
    host_->RemoveChildViewT(std::exchange(player_view_, nullptr).get());
  }
  if (player) {
    player->PresenterGone(this);
  }
}

void PipPresenter::RendererRetired() {
  attached_generation_.reset();
  ReleasePlayer();
}

void PipPresenter::CheckSource() {
  if (player_ && !host_->BindingForContents(player_->source())) {
    ReleasePlayer();
  }
}

void PipPresenter::SendPlayerEvent(const PipPlayer& player) {
  base::DictValue state =
      base::DictValue()
          .Set("player", static_cast<double>(player.presented_generation()))
          .Set("active", true)
          .Set("tab", player.source() ? TabId(player.source()) : 0)
          .Set("playing", player.playback_state() == content::VideoOverlayWindow::kPlaying)
          .Set("ended", player.playback_state() == content::VideoOverlayWindow::kEndOfVideo)
          .Set("playPause", player.play_pause_visible())
          .Set("origin", base::UTF16ToUTF8(player.source_title()))
          .Set("naturalWidth", player.natural_size().width())
          .Set("naturalHeight", player.natural_size().height());
  if (const std::optional<media_session::MediaPosition>& position = player.position()) {
    base::DictValue time;
    time.Set("current", position->GetPosition().InSecondsF());
    time.Set("rate", position->playback_rate());
    if (!position->duration().is_max() && position->duration().is_positive()) {
      time.Set("duration", position->duration().InSecondsF());
    }
    state.Set("position", std::move(time));
  }
  host_->Emit("ArdiaPip", "player", base::Value(std::move(state)));
}

}
