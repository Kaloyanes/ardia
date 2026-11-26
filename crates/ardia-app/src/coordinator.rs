use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::task::{Context, Poll};

use ardia_engine::{
    AutofillPromptAction, BrowserEngine, CastRoute, DownloadCommand, EngineBackend,
    EngineProfileId, EngineTabId, EngineWindowId, NativeView, NativeWindow, PasswordPromptAction,
    PermissionResult, Rect, Services,
};
use ardia_state::actions::{Action, ActionError, Outcome};
use ardia_state::air_traffic::LinkSource;
use ardia_state::model::PageKind;
use ardia_state::tabs::FindState;
use ardia_state::windows::WindowKind;
use ardia_state::{BrowserStore, Interest, ProfileId, TabId, Topics, Update, WindowId};
use ardia_theme::IconTheme;
use ardia_ui::{HostTabView, UiHost, UtilityWindowKind};
use gpui::AnyWindowHandle;
use parking_lot::Mutex;

use crate::events_pump::EngineFeed;
use crate::links::{LinkPlan, is_openable, plan_link};
use crate::main_thread::MainThread;
use crate::maps::{BiMap, ProfileMap, ProfileOwner};
use crate::prompts::{PromptBook, RequestKind};

pub type LocalTask = Pin<Box<dyn Future<Output = ()>>>;
pub type Spawner = Box<dyn Fn(LocalTask)>;
pub type Waker = Arc<dyn Fn() + Send + Sync>;
pub type Job = Box<dyn FnOnce(&AppCoordinator) + Send>;

const MAX_PUMP_ROUNDS: usize = 16;
const DEFAULT_FOLDER: &str = "Default";

#[derive(Clone, Debug, PartialEq)]
pub struct CoordinatorConfig {
    pub hosts_native_windows: bool,
    pub background: bool,
    pub onboarding: bool,
    pub default_frame: Rect,
}

impl Default for CoordinatorConfig {
    fn default() -> Self {
        Self {
            hosts_native_windows: false,
            background: false,
            onboarding: false,
            default_frame: Rect::new(0.0, 0.0, 1360.0, 860.0),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostedWindow {
    pub window: usize,
    pub view: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ShellEffect {
    OpenBrowserWindow {
        window: WindowId,
        kind: WindowKind,
        host: Option<HostedWindow>,
    },
    CloseWindow {
        window: WindowId,
    },
    FocusWindow {
        window: WindowId,
    },
    OpenUtility(UtilityWindowKind),
    ConfirmCloseWithDownloads {
        window: Option<WindowId>,
        request: u64,
        count: u32,
        quitting: bool,
    },
    ConfirmQuitWithDownloads {
        count: u32,
    },
    InstallMenu,
    Copy(String),
    Quit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Presentation {
    Activate,
    ShowInactive,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PumpReport {
    pub events: usize,
    pub jobs: usize,
    pub rounds: usize,
    pub refresh: Vec<WindowId>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Applied {
    pub muted: bool,
    pub zoom: f64,
    pub pinned: bool,
    pub asleep: bool,
}

impl Default for Applied {
    fn default() -> Self {
        Self {
            muted: false,
            zoom: 1.0,
            pinned: false,
            asleep: false,
        }
    }
}

#[derive(Default)]
pub struct Bridge {
    pub windows: BiMap<WindowId, EngineWindowId>,
    pub tabs: BiMap<TabId, EngineTabId>,
    pub tab_homes: HashMap<TabId, WindowId>,
    pub profiles: ProfileMap,
    pub profile_paths: HashMap<ProfileId, String>,
    pub profile_waits: HashSet<ProfileId>,
    pub profile_failures: HashMap<ProfileId, u32>,
    pub pending_tabs: HashSet<TabId>,
    pub placeholders: HashMap<WindowId, TabId>,
    pub shown: HashMap<WindowId, Vec<TabId>>,
    pub engine_active: HashMap<WindowId, EngineTabId>,
    pub window_profiles: HashMap<WindowId, ProfileId>,
    pub applied: HashMap<TabId, Applied>,
    pub icon_themes: HashMap<TabId, IconTheme>,
    pub icon_urls: HashMap<TabId, String>,
    pub favicon_pages: HashMap<TabId, String>,
    pub prompts: PromptBook,
    pub devtools_open: HashSet<TabId>,
    pub closing_windows: HashSet<EngineWindowId>,
    pub closing_tabs: HashSet<EngineTabId>,
    pub leave_confirmed: HashSet<EngineTabId>,
    pub asking_to_leave: HashSet<EngineTabId>,
    pub closing_rows: HashSet<TabId>,
    pub strays: HashMap<WindowId, EngineTabId>,
    pub gpui: HashMap<WindowId, AnyWindowHandle>,
    pub gpui_requested: HashSet<WindowId>,
    pub cast_routes: Vec<CastRoute>,
    pub window_failures: HashMap<WindowId, u32>,
    pub menu_signature: Option<u64>,
}

pub(crate) struct EngineSide {
    pub(crate) engine: Arc<dyn BrowserEngine>,
    pub(crate) hosted: HashMap<EngineWindowId, (NativeWindow, NativeView)>,
    pub(crate) views: HashMap<EngineTabId, NativeView>,
    pub(crate) devtools: HashMap<EngineTabId, NativeView>,
    spawner: Option<Spawner>,
    parked: Vec<LocalTask>,
}

pub struct AppCoordinator {
    me: Weak<AppCoordinator>,
    pub(crate) store: Arc<BrowserStore>,
    backend: EngineBackend,
    pub(crate) config: CoordinatorConfig,
    side: MainThread<RefCell<EngineSide>>,
    pub(crate) bridge: Mutex<Bridge>,
    effects: Mutex<Vec<ShellEffect>>,
    jobs: Mutex<VecDeque<Job>>,
    pub(crate) feed: Arc<EngineFeed>,
    waker: Mutex<Option<Waker>>,
    touched: Mutex<HashSet<WindowId>>,
    dirty: AtomicBool,
    pub(crate) shutting_down: Arc<AtomicBool>,
    pub(crate) started: AtomicBool,
    pending_urls: Mutex<Vec<String>>,
    platform_focus: Mutex<Option<WindowId>>,
    store_subscription: Mutex<Option<ardia_state::Subscription>>,
}

impl std::fmt::Debug for AppCoordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let bridge = self.bridge.lock();
        f.debug_struct("AppCoordinator")
            .field("backend", &self.backend)
            .field("windows", &bridge.windows.len())
            .field("tabs", &bridge.tabs.len())
            .finish()
    }
}

fn noop_poll(task: &mut LocalTask) -> Poll<()> {
    let waker = futures::task::noop_waker();
    let mut context = Context::from_waker(&waker);
    task.as_mut().poll(&mut context)
}

impl AppCoordinator {
    pub fn new(
        store: Arc<BrowserStore>,
        engine: Arc<dyn BrowserEngine>,
        config: CoordinatorConfig,
    ) -> Arc<Self> {
        let shutting_down = Arc::new(AtomicBool::new(false));
        let feed = EngineFeed::attach(engine.as_ref(), store.clone(), shutting_down.clone());
        let backend = engine.backend();
        let coordinator = Arc::new_cyclic(|me| AppCoordinator {
            me: me.clone(),
            store,
            backend,
            config,
            side: MainThread::new(RefCell::new(EngineSide {
                engine,
                hosted: HashMap::new(),
                views: HashMap::new(),
                devtools: HashMap::new(),
                spawner: None,
                parked: Vec::new(),
            })),
            bridge: Mutex::new(Bridge::default()),
            effects: Mutex::new(Vec::new()),
            jobs: Mutex::new(VecDeque::new()),
            feed,
            waker: Mutex::new(None),
            touched: Mutex::new(HashSet::new()),
            dirty: AtomicBool::new(true),
            shutting_down,
            started: AtomicBool::new(false),
            pending_urls: Mutex::new(Vec::new()),
            platform_focus: Mutex::new(None),
            store_subscription: Mutex::new(None),
        });
        let weak = Arc::downgrade(&coordinator);
        let subscription =
            coordinator
                .store
                .subscribe(Interest::Topics(Topics::ALL), move |update| {
                    if let Some(coordinator) = weak.upgrade() {
                        coordinator.note_store_update(update);
                    }
                });
        *coordinator.store_subscription.lock() = Some(subscription);
        let weak = Arc::downgrade(&coordinator);
        coordinator.feed.on_ready(move || {
            if let Some(coordinator) = weak.upgrade() {
                coordinator.wake();
            }
        });
        coordinator
    }

    pub fn weak(&self) -> Weak<AppCoordinator> {
        self.me.clone()
    }

    pub fn store(&self) -> &Arc<BrowserStore> {
        &self.store
    }

    pub fn backend(&self) -> EngineBackend {
        self.backend
    }

    pub fn config(&self) -> &CoordinatorConfig {
        &self.config
    }

    pub fn engine(&self) -> Option<Arc<dyn BrowserEngine>> {
        self.side.get().map(|side| side.borrow().engine.clone())
    }

    pub(crate) fn side(&self) -> Option<&RefCell<EngineSide>> {
        self.side.get()
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
    }

    pub fn set_waker(&self, waker: impl Fn() + Send + Sync + 'static) {
        *self.waker.lock() = Some(Arc::new(waker));
        self.wake();
    }

    pub fn wake(&self) {
        let waker = self.waker.lock().clone();
        if let Some(waker) = waker {
            waker();
        }
    }

    pub fn attach_spawner(&self, spawner: impl Fn(LocalTask) + 'static) {
        let Some(side) = self.side.get() else {
            log::error!("the spawner must be attached on the main thread");
            return;
        };
        let parked = {
            let mut side = side.borrow_mut();
            side.spawner = Some(Box::new(spawner));
            std::mem::take(&mut side.parked)
        };
        let side = side.borrow();
        if let Some(spawner) = side.spawner.as_ref() {
            for task in parked {
                spawner(task);
            }
        }
    }

    pub(crate) fn spawn(&self, task: impl Future<Output = ()> + 'static) {
        let Some(side) = self.side.get() else {
            log::error!("async engine work was started off the main thread and dropped");
            return;
        };
        let mut task: LocalTask = Box::pin(task);
        {
            let side = side.borrow();
            if let Some(spawner) = side.spawner.as_ref() {
                spawner(task);
                return;
            }
        }
        if noop_poll(&mut task).is_pending() {
            side.borrow_mut().parked.push(task);
        }
    }

    pub fn poll_parked(&self) -> usize {
        let Some(side) = self.side.get() else {
            return 0;
        };
        let parked = std::mem::take(&mut side.borrow_mut().parked);
        let mut still = Vec::new();
        for mut task in parked {
            if noop_poll(&mut task).is_pending() {
                still.push(task);
            }
        }
        let left = still.len();
        side.borrow_mut().parked.extend(still);
        left
    }

    pub fn post(&self, job: impl FnOnce(&AppCoordinator) + Send + 'static) {
        self.jobs.lock().push_back(Box::new(job));
        self.wake();
    }

    pub(crate) fn effect(&self, effect: ShellEffect) {
        self.effects.lock().push(effect);
        self.wake();
    }

    pub fn take_effects(&self) -> Vec<ShellEffect> {
        std::mem::take(&mut *self.effects.lock())
    }

    pub(crate) fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
        self.wake();
    }

    pub(crate) fn touch(&self, window: WindowId) {
        self.touched.lock().insert(window);
    }

    fn note_store_update(&self, update: &Update) {
        {
            let mut touched = self.touched.lock();
            touched.extend(update.changes.windows.iter().cloned());
            for tab in &update.changes.tabs {
                if let Some(tab) = update.state.tab(tab.as_str()) {
                    touched.insert(tab.window_id.clone());
                }
            }
        }
        let structural = update.changes.topics.intersects(
            Topics::WINDOWS
                | Topics::TABS
                | Topics::SPLITS
                | Topics::PROFILES
                | Topics::FOCUS
                | Topics::CLOSED,
        );
        if structural {
            self.dirty.store(true, Ordering::Release);
        }
        self.wake();
    }

    pub fn queue_urls(&self, urls: impl IntoIterator<Item = String>) {
        self.pending_urls.lock().extend(urls);
        self.wake();
    }

    pub fn start(&self) {
        if let Some(engine) = self.engine()
            && engine.is_started()
            && !self.started.swap(true, Ordering::AcqRel)
        {
            self.boot_session();
        }
        self.pump();
    }

    pub(crate) fn boot_session(&self) {
        let state = self.store.snapshot();
        let has_browser = state.windows.values().any(|w| w.kind.has_tabs());
        if !has_browser {
            self.dispatch_quietly(Action::OpenLastWindowOrNew);
        }
        self.effect(ShellEffect::InstallMenu);
        if self.config.onboarding && !self.config.background {
            self.effect(ShellEffect::OpenUtility(UtilityWindowKind::Onboarding));
        }
        self.mark_dirty();
    }

    pub fn is_started(&self) -> bool {
        self.started.load(Ordering::Acquire)
    }

    pub fn pump(&self) -> PumpReport {
        let mut report = PumpReport::default();
        if !self.side.is_owner() {
            return report;
        }
        for _ in 0..MAX_PUMP_ROUNDS {
            let events = self.feed.take();
            let jobs: Vec<Job> = self.jobs.lock().drain(..).collect();
            let urls: Vec<String> = if self.is_started() {
                std::mem::take(&mut *self.pending_urls.lock())
            } else {
                Vec::new()
            };
            let dirty = self.dirty.swap(false, Ordering::AcqRel);
            if events.is_empty() && jobs.is_empty() && urls.is_empty() && !dirty {
                break;
            }
            report.rounds += 1;
            report.events += events.len();
            report.jobs += jobs.len();
            self.apply_events(events);
            for job in jobs {
                job(self);
            }
            for url in urls {
                self.open_url(&url);
            }
            if self.is_started() {
                self.reconcile();
            }
        }
        let busy = !self.feed.is_idle()
            || !self.jobs.lock().is_empty()
            || self.dirty.load(Ordering::Acquire);
        if busy {
            self.wake();
        }
        report.refresh = self.touched.lock().drain().collect();
        report
    }

    pub(crate) fn dispatch_quietly(&self, action: Action) -> Option<Outcome> {
        let name = action_name(&action);
        match self.store.dispatch(action) {
            Ok(outcome) => Some(outcome),
            Err(problem) => {
                log::debug!("{name} changed nothing: {problem}");
                None
            }
        }
    }

    pub fn dispatch_action(&self, action: Action) -> Result<Outcome, ActionError> {
        if let Action::CloseWindow { window } = &action {
            if self.is_shutting_down() {
                log::debug!("{window} stays in the session while Ardia quits");
                return Ok(Outcome::default());
            }
            if self.close_through_engine(window) {
                return Ok(Outcome::default());
            }
        }
        let closing = self.pages_closed_by(&action);
        if self.side.is_owner() && self.ask_before_closing(&action, &closing) {
            return Ok(Outcome::default());
        }
        let intent = Intent::of(&action, self);
        let outcome = self.store.dispatch(action)?;
        self.follow_through(intent, &outcome);
        self.retire_unloaded(&closing.unloaded);
        if self.side.is_owner() && self.is_started() {
            self.reconcile();
        } else {
            self.mark_dirty();
        }
        Ok(outcome)
    }

    fn follow_through(&self, intent: Intent, outcome: &Outcome) {
        match intent {
            Intent::None => {}
            Intent::Navigate(tab) => self.load_navigation(&tab),
            Intent::Duplicate(source) => {
                if let Some(copy) = outcome.tab.clone() {
                    self.duplicate_in_engine(&source, &copy);
                }
            }
            Intent::DeleteProfile(Some(profile)) => {
                if let Some(engine) = self.engine() {
                    let reply = engine.delete_profile(profile);
                    self.spawn(async move {
                        if let Err(problem) = reply.await {
                            log::warn!("the engine kept a deleted profile's data: {problem}");
                        }
                    });
                }
            }
            Intent::DeleteProfile(None) => {}
        }
    }

    pub(crate) fn pages_closed_by(&self, action: &Action) -> ClosingPages {
        if !matches!(
            action,
            Action::CloseTabs { .. } | Action::ClearUnpinned { .. } | Action::CloseGroup { .. }
        ) {
            return ClosingPages::default();
        }
        let state = self.store.snapshot();
        let Ok((next, _)) = state.reduce(
            action.clone(),
            ardia_state::store::now_ms(),
            self.store.ids(),
        ) else {
            return ClosingPages::default();
        };
        let mut pages = ClosingPages::default();
        for (id, before) in state.tabs.iter() {
            match next.tabs.get(id) {
                None => pages.removed.push(id.clone()),
                Some(after)
                    if before.page.kind != PageKind::Asleep
                        && after.page.kind == PageKind::Asleep =>
                {
                    pages.unloaded.push(id.clone())
                }
                Some(_) => {}
            }
        }
        pages.removed.sort();
        pages.unloaded.sort();
        pages
    }

    fn ask_before_closing(&self, action: &Action, closing: &ClosingPages) -> bool {
        let all = closing.all();
        if all.is_empty() {
            return false;
        }
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return false;
        };
        let live: Vec<(TabId, EngineTabId)> = {
            let bridge = self.bridge.lock();
            all.iter()
                .filter_map(|tab| {
                    bridge
                        .tabs
                        .by_left(tab)
                        .map(|engine_tab| (tab.clone(), *engine_tab))
                })
                .filter(|(_, engine_tab)| !bridge.leave_confirmed.contains(engine_tab))
                .collect()
        };
        let still_asking = {
            let bridge = self.bridge.lock();
            live.iter()
                .find(|(_, engine_tab)| bridge.asking_to_leave.contains(engine_tab))
                .map(|(tab, _)| tab.clone())
        };
        if let Some(tab) = still_asking {
            log::info!("{tab} is still asking before it closes, so it comes forward");
            self.dispatch_quietly(Action::ActivateTab { tab });
            self.mark_dirty();
            return true;
        }
        let asking: Vec<(TabId, EngineTabId)> = live
            .into_iter()
            .filter(|(_, engine_tab)| {
                engine
                    .tab_info(*engine_tab)
                    .is_ok_and(|info| info.asks_before_leaving)
            })
            .collect();
        if asking.is_empty() {
            return false;
        }
        let fronts = self.front_tabs(&all);
        {
            let mut bridge = self.bridge.lock();
            bridge
                .asking_to_leave
                .extend(asking.iter().map(|(_, engine_tab)| *engine_tab));
            bridge.closing_rows.extend(all.iter().cloned());
        }
        let me = self.weak();
        let action = action.clone();
        self.spawn(async move {
            let mut staying = Vec::new();
            for (tab, engine_tab) in asking {
                let Some(coordinator) = me.upgrade() else {
                    return;
                };
                coordinator.dispatch_quietly(Action::ActivateTab { tab: tab.clone() });
                if coordinator.is_started() {
                    coordinator.reconcile();
                }
                log::info!("{tab} asks before it closes");
                let reply = engine.ask_before_leaving(engine_tab);
                drop(coordinator);
                let answer = reply.await;
                log::info!("{tab} answered {answer:?}");
                let leave = answer.unwrap_or(true);
                let Some(coordinator) = me.upgrade() else {
                    return;
                };
                {
                    let mut bridge = coordinator.bridge.lock();
                    bridge.asking_to_leave.remove(&engine_tab);
                    if leave {
                        bridge.leave_confirmed.insert(engine_tab);
                    } else {
                        bridge.closing_rows.remove(&tab);
                    }
                }
                if leave {
                    coordinator.retire_engine_tab(&tab, engine_tab, &engine);
                    coordinator.mark_dirty();
                } else {
                    staying.push(tab);
                }
            }
            if let Some(coordinator) = me.upgrade() {
                coordinator.finish_closing(action, all, &staying, fronts);
            }
        });
        true
    }

    fn front_tabs(&self, closing: &[TabId]) -> Vec<TabId> {
        let state = self.store.snapshot();
        let mut fronts: Vec<TabId> = Vec::new();
        for tab in closing {
            let front = state
                .tab(tab.as_str())
                .and_then(|listed| state.active_tab(listed.window_id.as_str()))
                .map(|front| front.id.clone());
            if let Some(front) = front
                && !closing.contains(&front)
                && !fronts.contains(&front)
            {
                fronts.push(front);
            }
        }
        fronts
    }

    fn finish_closing(
        &self,
        action: Action,
        all: Vec<TabId>,
        staying: &[TabId],
        fronts: Vec<TabId>,
    ) {
        let state = self.store.snapshot();
        let expected: Vec<TabId> = all
            .iter()
            .filter(|tab| !staying.contains(tab) && state.tab(tab.as_str()).is_some())
            .cloned()
            .collect();
        if !expected.is_empty() {
            if staying.is_empty() {
                for front in fronts
                    .iter()
                    .filter(|front| state.tab(front.as_str()).is_some())
                {
                    self.dispatch_quietly(Action::ActivateTab { tab: front.clone() });
                }
            }
            let last_closes_window = matches!(
                action,
                Action::CloseTabs {
                    last_closes_window: true,
                    ..
                }
            );
            let action = self.closing_after_asking(action, &expected, staying, last_closes_window);
            if let Some(action) = action {
                let name = action_name(&action);
                if let Err(problem) = self.dispatch_action(action) {
                    log::debug!("{name} changed nothing after asking: {problem}");
                }
            }
        }
        {
            let mut bridge = self.bridge.lock();
            for tab in &all {
                bridge.closing_rows.remove(tab);
            }
        }
        self.mark_dirty();
    }

    fn closing_after_asking(
        &self,
        action: Action,
        expected: &[TabId],
        staying: &[TabId],
        last_closes_window: bool,
    ) -> Option<Action> {
        let keeps_stayers = |candidate: &Action| -> bool {
            self.pages_closed_by(candidate)
                .all()
                .iter()
                .all(|tab| !staying.contains(tab))
        };
        let matches_expected =
            |candidate: &Action| same_tabs(&self.pages_closed_by(candidate).all(), expected);
        let replay = match &action {
            Action::CloseGroup { group } if !staying.is_empty() => {
                self.dispatch_quietly(Action::RemoveFromGroups {
                    tabs: staying.to_vec(),
                });
                Some(Action::CloseGroup {
                    group: group.clone(),
                })
            }
            _ if staying.is_empty() => Some(action),
            _ => None,
        };
        if let Some(replay) =
            replay.filter(|candidate| matches_expected(candidate) && keeps_stayers(candidate))
        {
            return Some(replay);
        }
        let close = |tabs: Vec<TabId>| Action::CloseTabs {
            tabs,
            last_closes_window,
        };
        let everything = close(expected.to_vec());
        if keeps_stayers(&everything) {
            return Some(everything);
        }
        let safe: Vec<TabId> = expected
            .iter()
            .filter(|tab| keeps_stayers(&close(vec![(*tab).clone()])))
            .cloned()
            .collect();
        let safe = close(safe);
        if keeps_stayers(&safe) {
            return Some(safe);
        }
        log::info!(
            "closing the rest would take a page that stayed with it, so nothing more closes"
        );
        None
    }

    fn retire_unloaded(&self, tabs: &[TabId]) {
        if tabs.is_empty() {
            return;
        }
        let Some(engine) = self.engine() else {
            return;
        };
        let state = self.store.snapshot();
        for tab in tabs.iter().filter(|tab| state.tab(tab.as_str()).is_some()) {
            if let Some(engine_tab) = self.engine_tab(tab) {
                self.retire_engine_tab(tab, engine_tab, &engine);
            }
        }
    }

    pub fn follow_platform_focus(&self, window: Option<&WindowId>) {
        let changed = {
            let mut last = self.platform_focus.lock();
            let changed = last.as_ref() != window;
            *last = window.cloned();
            changed
        };
        if changed {
            self.focus_browser_window(window);
        }
    }

    pub fn platform_window(&self) -> Option<WindowId> {
        #[cfg(target_os = "macos")]
        if self.config.hosts_native_windows {
            return self.app_main_window();
        }
        self.platform_focus.lock().clone()
    }

    pub fn focus_platform_window(&self) {
        let window = self.platform_window();
        self.focus_browser_window(window.as_ref());
    }

    pub fn command_window(&self, state: &ardia_state::BrowserState) -> Option<WindowId> {
        self.platform_window()
            .filter(|window| {
                state
                    .window(window.as_str())
                    .is_some_and(|w| w.kind.has_tabs())
            })
            .or_else(|| crate::menu_bridge::focused_window(state))
    }

    #[cfg(target_os = "macos")]
    fn app_main_window(&self) -> Option<WindowId> {
        let main = crate::hosted_input::main_window()?;
        let engine_window = {
            let side = self.side.get()?.try_borrow().ok()?;
            side.hosted
                .iter()
                .find(|(_, (native, _))| native.handle().as_ptr() as usize == main)
                .map(|(engine_window, _)| *engine_window)?
        };
        self.bridge.lock().windows.by_right(&engine_window).cloned()
    }

    fn focus_browser_window(&self, window: Option<&WindowId>) {
        let Some(window) = window else {
            return;
        };
        let state = self.store.snapshot();
        let browser = state
            .window(window.as_str())
            .is_some_and(|w| w.kind.has_tabs());
        if browser && state.focus_order.first() != Some(window) {
            self.dispatch_quietly(Action::FocusWindow {
                window: window.clone(),
            });
        }
    }

    fn close_through_engine(&self, window: &WindowId) -> bool {
        if self.is_shutting_down() || !self.side.is_owner() {
            return false;
        }
        let Some(engine_window) = self.bridge.lock().windows.by_left(window).copied() else {
            return false;
        };
        let Some(engine) = self.engine().filter(|engine| engine.is_started()) else {
            return false;
        };
        self.bridge.lock().closing_windows.insert(engine_window);
        match engine.close_window(engine_window) {
            Ok(()) => true,
            Err(problem) => {
                log::warn!("the engine couldn't close {window}: {problem}");
                self.bridge.lock().closing_windows.remove(&engine_window);
                self.bridge.lock().windows.remove_left(window);
                false
            }
        }
    }

    fn load_navigation(&self, tab: &TabId) {
        let state = self.store.snapshot();
        let Some(url) = state
            .tab(tab.as_str())
            .and_then(|t| t.live.navigation.clone().or_else(|| Some(t.url.clone())))
            .filter(|url| !url.is_empty())
        else {
            return;
        };
        let engine_tab = self.bridge.lock().tabs.by_left(tab).copied();
        if let (Some(engine_tab), Some(engine)) = (engine_tab, self.engine())
            && let Err(problem) = engine.load_url(engine_tab, &url, true)
        {
            log::warn!("{tab} couldn't load {url}: {problem}");
        }
    }

    pub fn open_url(&self, url: &str) {
        if !is_openable(url) {
            log::warn!("ignored a link that can't be opened");
            return;
        }
        let state = self.store.snapshot();
        let url = url.trim().to_owned();
        match plan_link(&state, &url, &LinkSource::default()) {
            LinkPlan::NewTab {
                window,
                profile,
                group,
            } => {
                let outcome = self.dispatch_quietly(Action::NewTab {
                    window: window.clone(),
                    tab: ardia_state::NewTab {
                        url: Some(url),
                        profile: Some(profile),
                        ..ardia_state::NewTab::default()
                    },
                });
                if let (Some(group), Some(tab)) = (group, outcome.and_then(|o| o.tab)) {
                    self.dispatch_quietly(Action::AddToGroup {
                        group,
                        tabs: vec![tab],
                    });
                }
                self.dispatch_quietly(Action::FocusWindow {
                    window: window.clone(),
                });
                self.effect(ShellEffect::FocusWindow { window });
            }
            LinkPlan::NewWindow { kind, profile } => {
                self.dispatch_quietly(Action::OpenWindow {
                    kind,
                    profile: Some(profile),
                    url: Some(url),
                    frame: None,
                });
            }
        }
        self.mark_dirty();
    }

    pub fn engine_tab(&self, tab: &TabId) -> Option<EngineTabId> {
        self.bridge.lock().tabs.by_left(tab).copied()
    }

    pub fn engine_is_quitting(&self) -> bool {
        let Some(engine) = self.engine() else {
            return true;
        };
        if !engine.is_started() {
            return true;
        }
        match engine.query(ardia_engine::EngineQuery::KeepAliveState) {
            Ok(state) => state
                .as_str()
                .is_some_and(|state| state.contains("trying_to_quit=1")),
            Err(_) => self.backend == EngineBackend::Mac,
        }
    }

    pub fn engine_window(&self, window: &WindowId) -> Option<EngineWindowId> {
        self.bridge.lock().windows.by_left(window).copied()
    }

    pub fn engine_profile(&self, profile: &ProfileId) -> Option<EngineProfileId> {
        self.bridge.lock().profiles.engine_of(profile)
    }

    pub(crate) fn profile_owner(&self, engine_profile: EngineProfileId) -> Option<Owner> {
        if let Some(owner) = self.bridge.lock().profiles.owner(engine_profile).cloned() {
            return Some(Owner {
                owner,
                certain: true,
            });
        }
        let info = self.engine()?.profile_info(engine_profile).ok()?;
        if !info.off_the_record {
            return None;
        }
        let state = self.store.snapshot();
        let Some(original) = self.private_original(&state, &info.path) else {
            log::info!("{engine_profile} is private, but its own profile isn't known yet");
            return Some(Owner {
                owner: ProfileOwner::Private(state.last_active_profile()),
                certain: false,
            });
        };
        let owner = ProfileOwner::Private(original);
        self.bridge
            .lock()
            .profiles
            .note_owner(engine_profile, owner.clone());
        Some(Owner {
            owner,
            certain: true,
        })
    }

    fn private_original(&self, state: &ardia_state::BrowserState, path: &str) -> Option<ProfileId> {
        if path.is_empty() {
            return None;
        }
        let private = std::path::Path::new(path);
        let by_path = state
            .profile_order
            .iter()
            .filter(|profile| !profile.is_incognito() && self.engine_profile(profile).is_some())
            .filter_map(|profile| {
                let own = self.service_profile_dir(profile)?;
                (!own.is_empty() && private.starts_with(&own)).then(|| (own.len(), profile.clone()))
            })
            .max_by_key(|(length, _)| *length)
            .map(|(_, profile)| profile);
        by_path.or_else(|| {
            let names: Vec<&std::ffi::OsStr> = [
                private.file_name(),
                private.parent().and_then(std::path::Path::file_name),
            ]
            .into_iter()
            .flatten()
            .collect();
            state
                .profile_order
                .iter()
                .filter(|profile| !profile.is_incognito())
                .find(|profile| {
                    let folder = state.engine_profile(profile);
                    let folder = if folder.is_empty() {
                        DEFAULT_FOLDER.to_owned()
                    } else {
                        folder
                    };
                    names
                        .iter()
                        .any(|name| *name == std::ffi::OsStr::new(&folder))
                })
                .cloned()
        })
    }

    pub(crate) fn engine_profile_of(&self, tab: &TabId) -> Option<EngineProfileId> {
        let profile = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .map(|t| t.profile_id.clone())?;
        self.engine_profile(&profile)
    }

    pub fn gpui_window(&self, window: &WindowId) -> Option<AnyWindowHandle> {
        self.bridge.lock().gpui.get(window).copied()
    }

    pub fn cast_routes(&self) -> Vec<CastRoute> {
        self.bridge.lock().cast_routes.clone()
    }

    pub fn held_prompts(&self) -> Vec<ardia_engine::EngineEvent> {
        self.bridge.lock().prompts.held()
    }

    pub fn blocked_popups(&self, tab: &TabId) -> Vec<ardia_engine::BlockedPopup> {
        self.bridge.lock().prompts.blocked_popups(tab).to_vec()
    }

    pub fn open_blocked_popup(&self, tab: &TabId, popup_id: &str, always: bool) -> bool {
        let popup = self.bridge.lock().prompts.take_popup(tab, popup_id);
        match (popup, self.engine_tab(tab), self.engine()) {
            (Some(popup), Some(engine_tab), Some(engine)) => engine
                .open_blocked_popup(engine_tab, &popup.id, always)
                .is_ok(),
            _ => false,
        }
    }

    pub fn devtools_open(&self, tab: &TabId) -> bool {
        self.bridge.lock().devtools_open.contains(tab)
    }

    fn with_engine_tab(
        &self,
        tab: &TabId,
        what: &str,
        run: impl FnOnce(&dyn BrowserEngine, EngineTabId) -> ardia_engine::EngineResult<()>,
    ) {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(tab), self.engine()) else {
            log::debug!("{tab} has no page yet to {what}");
            return;
        };
        if let Err(problem) = run(engine.as_ref(), engine_tab) {
            log::warn!("{tab} couldn't {what}: {problem}");
        }
    }

    pub(crate) fn forget_devtools_view(&self, tab: EngineTabId) {
        if let Some(side) = self.side.get() {
            let view = side.borrow_mut().devtools.remove(&tab);
            drop(view);
        }
    }

    pub(crate) fn forget_hosted(&self, window: EngineWindowId) {
        if let Some(side) = self.side.get() {
            let hosted = side.borrow_mut().hosted.remove(&window);
            drop(hosted);
        }
    }

    pub fn present_window(&self, window: &WindowId) -> Presentation {
        let focused = self.store.snapshot().focus_order.first() == Some(window);
        if focused && !self.config.background {
            return Presentation::Activate;
        }
        if let (Some(engine_window), Some(engine)) = (self.engine_window(window), self.engine())
            && let Err(problem) = engine.show_inactive(engine_window)
        {
            log::warn!("{window} didn't come on screen: {problem}");
        }
        Presentation::ShowInactive
    }

    pub fn host_alive(&self, window: &WindowId, host: HostedWindow) -> bool {
        let (Some(engine_window), Some(side)) = (self.engine_window(window), self.side.get())
        else {
            return false;
        };
        side.borrow()
            .hosted
            .get(&engine_window)
            .is_some_and(|(native, view)| {
                native.handle().as_ptr() as usize == host.window
                    && view.handle().as_ptr() as usize == host.view
            })
    }

    pub fn tab_views(&self, tab: &TabId) -> Option<HostTabView> {
        let state = self.store.snapshot();
        state.tab(tab.as_str())?;
        let empty = HostTabView {
            tab_id: tab.clone(),
            page_view: None,
            devtools_view: None,
        };
        if self.backend != EngineBackend::Mac {
            return Some(empty);
        }
        let engine_tab = self.engine_tab(tab)?;
        let side = self.side.get()?;
        let engine = self.engine()?;
        let cached = side.borrow().views.get(&engine_tab).map(NativeView::handle);
        let page_view = match cached {
            Some(handle) => Some(handle),
            None => match engine.native_view_handle(engine_tab) {
                Ok(view) => {
                    let handle = view.handle();
                    side.borrow_mut().views.insert(engine_tab, view);
                    log::debug!("{tab} shows its page");
                    Some(handle)
                }
                Err(problem) => {
                    log::debug!("{tab} has no page view yet: {problem}");
                    None
                }
            },
        };
        let devtools_view = if self.devtools_open(tab) {
            let cached = side
                .borrow()
                .devtools
                .get(&engine_tab)
                .map(NativeView::handle);
            match cached {
                Some(handle) => Some(handle),
                None => match engine.devtools_view_handle(engine_tab) {
                    Ok(Some(view)) => {
                        let handle = view.handle();
                        side.borrow_mut().devtools.insert(engine_tab, view);
                        Some(handle)
                    }
                    _ => None,
                },
            }
        } else {
            None
        };
        Some(HostTabView {
            page_view,
            devtools_view,
            ..empty
        })
    }

    pub fn request_quit(&self) {
        let downloading = self.downloads_in_progress();
        let windowless = self.bridge.lock().windows.is_empty();
        if downloading > 0 && windowless && !self.config.background && !self.is_shutting_down() {
            self.effect(ShellEffect::ConfirmQuitWithDownloads { count: downloading });
            return;
        }
        self.quit_now();
    }

    pub fn quit_now(&self) {
        self.begin_shutdown();
        if !self.store.flush(crate::events_pump::SHUTDOWN_FLUSH) {
            log::warn!("the session didn't finish saving before quitting");
        }
        self.effect(ShellEffect::Quit);
    }

    pub fn downloads_in_progress(&self) -> u32 {
        let state = self.store.snapshot();
        let active = state
            .downloads
            .items()
            .iter()
            .filter(|download| download.is_active())
            .count();
        u32::try_from(active).unwrap_or(u32::MAX)
    }

    pub fn flush(&self) -> bool {
        self.store.flush(crate::events_pump::SHUTDOWN_FLUSH)
    }

    fn resolve_request(&self, request_id: &str, result: PermissionResult, remember: bool) {
        let Some(engine) = self.engine() else {
            return;
        };
        let request = self.bridge.lock().prompts.request(request_id);
        let outcome = match request.map(|(_, kind)| kind) {
            Some(RequestKind::ExternalApp) => engine.resolve_external_app(
                request_id,
                result == PermissionResult::Accept,
                remember,
            ),
            _ => engine.resolve_permission(request_id, result, remember),
        };
        if let Err(problem) = outcome {
            log::warn!("couldn't answer {request_id}: {problem}");
        }
        let tab = self.bridge.lock().prompts.settle_request(request_id);
        if let Some(tab) = tab {
            self.publish_prompts(&tab);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Owner {
    pub owner: ProfileOwner,
    pub certain: bool,
}

enum Intent {
    None,
    Navigate(TabId),
    Duplicate(TabId),
    DeleteProfile(Option<EngineProfileId>),
}

impl Intent {
    fn of(action: &Action, coordinator: &AppCoordinator) -> Self {
        match action {
            Action::Navigate { tab, .. } => Intent::Navigate(tab.clone()),
            Action::DuplicateTab { tab } => Intent::Duplicate(tab.clone()),
            Action::DeleteProfile { profile } => {
                Intent::DeleteProfile(coordinator.engine_profile(profile))
            }
            _ => Intent::None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClosingPages {
    pub removed: Vec<TabId>,
    pub unloaded: Vec<TabId>,
}

impl ClosingPages {
    pub fn all(&self) -> Vec<TabId> {
        self.removed.iter().chain(&self.unloaded).cloned().collect()
    }
}

fn same_tabs(left: &[TabId], right: &[TabId]) -> bool {
    let left: HashSet<&TabId> = left.iter().collect();
    let right: HashSet<&TabId> = right.iter().collect();
    left == right
}

pub fn action_name(action: &Action) -> String {
    let shown = format!("{action:?}");
    let end = shown.find([' ', '{', '(']).unwrap_or(shown.len());
    shown[..end].to_owned()
}

fn password_action(action: &str) -> Option<PasswordPromptAction> {
    Some(match action {
        "save" => PasswordPromptAction::Save,
        "update" => PasswordPromptAction::Update,
        "never" => PasswordPromptAction::Never,
        "nope" | "notNow" => PasswordPromptAction::Nope,
        "dismiss" => PasswordPromptAction::Dismiss,
        _ => return None,
    })
}

fn autofill_action(action: &str) -> Option<AutofillPromptAction> {
    Some(match action {
        "accept" => AutofillPromptAction::Accept,
        "decline" => AutofillPromptAction::Decline,
        "dismiss" => AutofillPromptAction::Dismiss,
        _ => return None,
    })
}

fn unix_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(1.0, |d| d.as_secs_f64())
}

impl UiHost for AppCoordinator {
    fn store(&self) -> &Arc<BrowserStore> {
        &self.store
    }

    fn dispatch(&self, action: Action) {
        let name = action_name(&action);
        if let Err(problem) = self.dispatch_action(action) {
            log::debug!("{name} changed nothing: {problem}");
        }
    }

    fn navigate(&self, _window: WindowId, tab: TabId, input: String) {
        self.dispatch(Action::Navigate { tab, input });
    }

    fn go_back(&self, tab: TabId) {
        self.with_engine_tab(&tab, "go back", |engine, id| engine.go_back(id));
    }

    fn go_forward(&self, tab: TabId) {
        self.with_engine_tab(&tab, "go forward", |engine, id| engine.go_forward(id));
    }

    fn reload(&self, tab: TabId, ignore_cache: bool) {
        self.with_engine_tab(&tab, "reload", |engine, id| {
            if ignore_cache {
                engine.reload_ignoring_cache(id)
            } else {
                engine.reload(id)
            }
        });
    }

    fn stop_loading(&self, tab: TabId) {
        self.with_engine_tab(&tab, "stop", |engine, id| engine.stop(id));
    }

    fn set_muted(&self, tab: TabId, muted: bool) {
        self.dispatch(Action::SetMuted { tab, muted });
    }

    fn set_zoom(&self, tab: TabId, factor: f64) {
        self.dispatch(Action::SetZoom { tab, zoom: factor });
    }

    fn zoom_step(&self, tab: TabId, direction: i32) {
        let direction = direction.clamp(-1, 1);
        self.with_engine_tab(&tab, "zoom", |engine, id| engine.zoom_step(id, direction));
    }

    fn find_in_page(&self, tab: TabId, query: String, forward: bool) {
        let state = self.store.snapshot();
        let current = state
            .tab(tab.as_str())
            .map(|t| t.live.find.clone())
            .unwrap_or_default();
        let fresh = current.query != query;
        self.dispatch(Action::SetFind {
            tab: tab.clone(),
            find: FindState {
                open: true,
                query: query.clone(),
                count: if fresh { None } else { current.count },
                ..current
            },
        });
        if query.is_empty() {
            self.with_engine_tab(&tab, "stop finding", |engine, id| engine.stop_finding(id));
        } else {
            self.with_engine_tab(&tab, "find", |engine, id| engine.find(id, &query, forward));
        }
    }

    fn stop_finding(&self, tab: TabId) {
        self.with_engine_tab(&tab, "stop finding", |engine, id| engine.stop_finding(id));
        self.dispatch(Action::SetFind {
            tab,
            find: FindState::default(),
        });
    }

    fn toggle_devtools(&self, tab: TabId) {
        let open = self.devtools_open(&tab);
        self.with_engine_tab(&tab, "toggle DevTools", |engine, id| {
            if open {
                engine.close_devtools(id)
            } else {
                engine.show_devtools(id)
            }
        });
    }

    fn enter_pip(&self, tab: TabId) {
        let (Some(engine_tab), Some(engine)) = (self.engine_tab(&tab), self.engine()) else {
            return;
        };
        let reply = engine.enter_pip(engine_tab, unix_seconds());
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::debug!("picture in picture didn't start: {problem}");
            }
        });
    }

    fn show_cast(&self, tab: TabId) {
        self.with_engine_tab(&tab, "cast", |engine, id| {
            engine.show_cast_dialog(id).map(|_| ())
        });
    }

    fn share_tab(&self, tab: TabId) {
        let state = self.store.snapshot();
        let Some(url) = state
            .tab(tab.as_str())
            .map(|t| t.url.clone())
            .filter(|url| !url.is_empty())
        else {
            return;
        };
        self.share_url(&tab, &url);
    }

    fn tab_native_views(&self, tab_id: TabId) -> Option<HostTabView> {
        self.tab_views(&tab_id)
    }

    fn icon_theme_for(&self, tab_id: TabId) -> Option<IconTheme> {
        let cached = self.bridge.lock().icon_themes.get(&tab_id).copied();
        cached.or_else(|| {
            self.store
                .snapshot()
                .tab(tab_id.as_str())
                .and_then(|t| t.live.icon_theme)
        })
    }

    fn download_command(&self, download_id: String, command: DownloadCommand) {
        let Some(engine) = self.engine() else {
            return;
        };
        let profile_dir = self
            .store
            .snapshot()
            .downloads
            .get(&download_id)
            .and_then(|d| d.profile.clone())
            .unwrap_or_default();
        let reply = Services::new(engine.as_ref(), &profile_dir)
            .downloads()
            .command(&download_id, command);
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::warn!("the download command didn't run: {problem}");
            }
        });
    }

    fn reveal_path(&self, path: String) {
        #[cfg(target_os = "macos")]
        if let Err(problem) =
            ardia_engine::macos::platform::reveal_in_finder(&[std::path::PathBuf::from(&path)])
        {
            log::warn!("couldn't show {path} in Finder: {problem}");
        }
        #[cfg(not(target_os = "macos"))]
        log::info!("revealing {path} isn't supported here yet");
    }

    fn resolve_permission(&self, request_id: String, result: PermissionResult, remember: bool) {
        self.resolve_request(&request_id, result, remember);
    }

    fn resolve_password_prompt(
        &self,
        tab: TabId,
        action: String,
        username: Option<String>,
        password: Option<String>,
    ) {
        let Some(action) = password_action(&action) else {
            log::warn!("{action} isn't a password prompt answer");
            return;
        };
        self.with_engine_tab(&tab, "answer the password prompt", |engine, id| {
            engine.resolve_password_prompt(id, action, username.as_deref(), password.as_deref())
        });
        if self.bridge.lock().prompts.clear_password(&tab) {
            self.publish_prompts(&tab);
        }
    }

    fn resolve_autofill_prompt(&self, tab: TabId, prompt_id: i64, action: String) {
        let Some(action) = autofill_action(&action) else {
            log::warn!("{action} isn't an autofill answer");
            return;
        };
        self.with_engine_tab(&tab, "answer autofill", |engine, id| {
            engine.resolve_autofill_prompt(id, prompt_id, action)
        });
        if self
            .bridge
            .lock()
            .prompts
            .clear_autofill(&tab, Some(prompt_id))
        {
            self.publish_prompts(&tab);
        }
    }

    fn execute_extension_action(&self, tab: TabId, extension_id: String) {
        self.with_engine_tab(&tab, "run the extension", |engine, id| {
            engine
                .execute_extension_action(id, &extension_id)
                .map(|_| ())
        });
    }

    fn open_little_ardia_in_main(&self, window_id: WindowId) {
        self.dispatch(Action::PromoteLittleArdia { window: window_id });
    }

    fn open_utility_window(&self, kind: UtilityWindowKind) {
        self.effect(ShellEffect::OpenUtility(kind));
    }

    fn start_import(&self, source: String, profile_id: ProfileId) {
        crate::import::start(self, source, profile_id);
    }

    fn request_window_close(&self, window_id: WindowId) {
        self.dispatch(Action::CloseWindow { window: window_id });
    }

    fn register_gpui_window(&self, window_id: WindowId, handle: AnyWindowHandle) {
        let mut bridge = self.bridge.lock();
        bridge.gpui_requested.remove(&window_id);
        bridge.gpui.insert(window_id, handle);
    }

    fn unregister_gpui_window(&self, window_id: WindowId) {
        let removed = self.bridge.lock().gpui.remove(&window_id).is_some();
        if !removed || self.config.hosts_native_windows || self.is_shutting_down() {
            return;
        }
        if self.store.snapshot().window(window_id.as_str()).is_none() {
            return;
        }
        self.post(move |coordinator| {
            let open = coordinator
                .store
                .snapshot()
                .window(window_id.as_str())
                .is_some();
            if open
                && !coordinator.is_shutting_down()
                && coordinator.gpui_window(&window_id).is_none()
            {
                coordinator.dispatch(Action::CloseWindow { window: window_id });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_names_are_short() {
        assert_eq!(
            action_name(&Action::OpenLastWindowOrNew),
            "OpenLastWindowOrNew"
        );
        assert_eq!(
            action_name(&Action::ActivateTab {
                tab: TabId::new("t")
            }),
            "ActivateTab"
        );
        assert_eq!(password_action("notNow"), Some(PasswordPromptAction::Nope));
        assert_eq!(password_action("bogus"), None);
        assert_eq!(
            autofill_action("accept"),
            Some(AutofillPromptAction::Accept)
        );
    }

    fn mock_coordinator() -> Arc<AppCoordinator> {
        let store = Arc::new(BrowserStore::in_memory(
            ardia_state::BrowserState::from_session(
                ardia_state::persistence::session::SessionData::fresh(
                    ardia_state::persistence::session::LoadOptions::default(),
                ),
                1_795_000_000_000,
            ),
            ardia_state::ids::IdGen::with_launch("unit"),
        ));
        let engine: Arc<dyn BrowserEngine> = Arc::new(ardia_engine::MockBrowserEngine::started());
        let app = AppCoordinator::new(store, engine, CoordinatorConfig::default());
        app.start();
        app.pump();
        app
    }

    fn background_tab(app: &AppCoordinator, window: &WindowId, url: &str) -> TabId {
        app.dispatch_action(Action::NewTab {
            window: window.clone(),
            tab: ardia_state::NewTab {
                url: Some(url.into()),
                background: true,
                ..ardia_state::NewTab::default()
            },
        })
        .unwrap()
        .tab
        .unwrap()
    }

    #[test]
    fn a_page_that_stayed_never_closes_with_its_source() {
        let app = mock_coordinator();
        let window = app.focused_window().unwrap();
        let source = background_tab(&app, &window, "https://source.example/");
        let other = background_tab(&app, &window, "https://other.example/");
        let peek = app
            .dispatch_action(Action::OpenPeek {
                window: window.clone(),
                url: "https://peek.example/".into(),
                source: Some(source.clone()),
            })
            .unwrap()
            .tab
            .unwrap();
        let everything = Action::CloseTabs {
            tabs: vec![source.clone(), other.clone(), peek.clone()],
            last_closes_window: false,
        };
        assert!(
            app.pages_closed_by(&Action::CloseTabs {
                tabs: vec![source.clone()],
                last_closes_window: false,
            })
            .all()
            .contains(&peek),
            "closing the source takes its Peek along"
        );
        let chosen = app
            .closing_after_asking(
                everything,
                &[source.clone(), other.clone()],
                std::slice::from_ref(&peek),
                false,
            )
            .expect("the other tab can still close");
        let closes = app.pages_closed_by(&chosen).all();
        assert!(!closes.contains(&peek), "the page that stayed stays");
        assert!(!closes.contains(&source), "and so does the tab it needs");
        assert!(closes.contains(&other));
    }

    #[test]
    fn a_group_with_a_page_that_stayed_still_closes_as_a_group() {
        let app = mock_coordinator();
        let window = app.focused_window().unwrap();
        let first = background_tab(&app, &window, "https://first.example/");
        let second = background_tab(&app, &window, "https://second.example/");
        let group = app
            .dispatch_action(Action::CreateGroup {
                tabs: vec![first.clone(), second.clone()],
                name: "Pair".into(),
            })
            .unwrap()
            .group
            .unwrap();
        let chosen = app
            .closing_after_asking(
                Action::CloseGroup {
                    group: group.clone(),
                },
                std::slice::from_ref(&first),
                std::slice::from_ref(&second),
                false,
            )
            .expect("the rest of the group closes");
        assert_eq!(chosen, Action::CloseGroup { group });
        assert_eq!(app.pages_closed_by(&chosen).all(), vec![first]);
        let state = app.store().snapshot();
        assert!(
            state.group_of(second.as_str()).is_none(),
            "the page that stayed left the group"
        );
    }

    #[test]
    fn a_replay_must_close_the_same_tabs() {
        let tabs = |ids: &[&str]| ids.iter().map(|id| TabId::new(*id)).collect::<Vec<_>>();
        assert!(same_tabs(&tabs(&["a", "b"]), &tabs(&["b", "a"])));
        assert!(!same_tabs(&tabs(&["a", "b"]), &tabs(&["a"])));
        assert!(!same_tabs(&tabs(&["a"]), &tabs(&["c"])));
        let pages = ClosingPages {
            removed: tabs(&["a"]),
            unloaded: tabs(&["p"]),
        };
        assert_eq!(pages.all(), tabs(&["a", "p"]));
    }
}
