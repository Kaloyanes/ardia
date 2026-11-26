use ardia_state::actions::{Action, NewTab};
use ardia_state::{TabId, WindowId};
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;
use crate::menu_bridge::{CommandOutcome, focused_window};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlError {
    pub code: &'static str,
    pub message: String,
}

impl ControlError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

pub const METHODS: &[&str] = &[
    "status",
    "open_url",
    "new_tab",
    "list_tabs",
    "navigate",
    "activate_tab",
    "close_tab",
    "eval_command",
    "quit",
];

pub const COMMANDS_BESIDE_PRIVATE_WINDOWS: &[&str] = &[
    "quit",
    "openSettings",
    "importBrowserData",
    "showOnboarding",
    "newWindow",
    "newLittleArdia",
    "reopenClosedWindow",
    "toggleOpenLinksInLittleArdia",
];

pub fn control_window(state: &ardia_state::BrowserState) -> Option<WindowId> {
    state
        .focus_order
        .iter()
        .filter_map(|id| state.window(id.as_str()))
        .find(|w| w.kind.has_tabs() && w.kind != ardia_state::windows::WindowKind::Incognito)
        .map(|w| w.id.clone())
}

fn text<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

impl AppCoordinator {
    pub fn answer_control(&self, method: &str, params: &Value) -> Result<Value, ControlError> {
        if !params.is_null() && !params.is_object() {
            return Err(ControlError::new("bad_params", "params must be an object"));
        }
        match method {
            "status" => Ok(self.control_status()),
            "open_url" => {
                let url = text(params, "url")
                    .ok_or_else(|| ControlError::new("bad_params", "open_url needs a url"))?;
                if !crate::links::is_openable(url) {
                    return Err(ControlError::new("bad_params", "that url can't be opened"));
                }
                self.open_url(url);
                Ok(json!({ "opened": true }))
            }
            "new_tab" => {
                let state = self.store().snapshot();
                let window = match text(params, "window") {
                    Some(id) => {
                        let id = WindowId::new(id);
                        let kind = state.window(id.as_str()).map(|w| w.kind);
                        if kind == Some(ardia_state::windows::WindowKind::Incognito) {
                            return Err(ControlError::new(
                                "private",
                                "the control socket doesn't act on private windows",
                            ));
                        }
                        if kind.is_none_or(|kind| !kind.has_tabs()) {
                            return Err(ControlError::new("not_found", "there's no such window"));
                        }
                        id
                    }
                    None => control_window(&state)
                        .ok_or_else(|| ControlError::new("not_found", "there's no window"))?,
                };
                let outcome = self
                    .dispatch_action(Action::NewTab {
                        window: window.clone(),
                        tab: NewTab {
                            url: text(params, "url").map(str::to_owned),
                            background: params
                                .get("background")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            ..NewTab::default()
                        },
                    })
                    .map_err(|e| ControlError::new("failed", e.to_string()))?;
                let tab = outcome
                    .tab
                    .ok_or_else(|| ControlError::new("failed", "no tab opened"))?;
                Ok(json!({ "tab": tab.as_str(), "window": window.as_str() }))
            }
            "list_tabs" => Ok(self.control_tabs()),
            "eval_command" => {
                let command = text(params, "command").ok_or_else(|| {
                    ControlError::new("bad_params", "eval_command needs a command")
                })?;
                let state = self.store().snapshot();
                let private_in_front = focused_window(&state)
                    .and_then(|window| state.window(window.as_str()).map(|w| w.kind))
                    .is_some_and(|kind| kind == ardia_state::windows::WindowKind::Incognito);
                if private_in_front && !COMMANDS_BESIDE_PRIVATE_WINDOWS.contains(&command) {
                    return Err(ControlError::new(
                        "private",
                        "a private window is in front, and the control socket doesn't act on private windows",
                    ));
                }
                match self.run_command(command, text(params, "arg")) {
                    Ok(CommandOutcome::Ran) => Ok(json!({ "ran": true, "by": "app" })),
                    Ok(CommandOutcome::ForUi) => Ok(json!({ "ran": true, "by": "ui" })),
                    Err(problem) => Err(ControlError::new("refused", problem)),
                }
            }
            "navigate" => {
                let tab = self.control_tab(params)?;
                let url = text(params, "url")
                    .ok_or_else(|| ControlError::new("bad_params", "navigate needs a url"))?;
                self.dispatch_action(Action::Navigate {
                    tab: tab.clone(),
                    input: url.to_owned(),
                })
                .map_err(|e| ControlError::new("failed", e.to_string()))?;
                Ok(json!({ "tab": tab.as_str() }))
            }
            "activate_tab" => {
                let tab = self.control_tab(params)?;
                self.dispatch_action(Action::ActivateTab { tab: tab.clone() })
                    .map_err(|e| ControlError::new("failed", e.to_string()))?;
                Ok(json!({ "tab": tab.as_str() }))
            }
            "close_tab" => {
                let tab = self.control_tab(params)?;
                self.dispatch_action(Action::CloseTabs {
                    tabs: vec![tab.clone()],
                    last_closes_window: false,
                })
                .map_err(|e| ControlError::new("failed", e.to_string()))?;
                if self.bridge.lock().closing_rows.contains(&tab) {
                    return Ok(json!({ "tab": tab.as_str(), "closed": false, "asking": true }));
                }
                Ok(json!({ "closed": tab.as_str() }))
            }
            "quit" => {
                self.request_quit();
                Ok(json!({ "quitting": true }))
            }
            _ => Err(ControlError::new(
                "unknown_method",
                format!(
                    "there's no method {method:?}; try one of {}",
                    METHODS.join(", ")
                ),
            )),
        }
    }

    fn control_tab(&self, params: &Value) -> Result<TabId, ControlError> {
        let id = text(params, "tab")
            .ok_or_else(|| ControlError::new("bad_params", "this method needs a tab"))?;
        let state = self.store().snapshot();
        let tab = state
            .tab(id)
            .filter(|tab| !tab.is_incognito() && !tab.live.peek)
            .ok_or_else(|| ControlError::new("not_found", "there's no such tab"))?;
        Ok(tab.id.clone())
    }

    fn control_status(&self) -> Value {
        let state = self.store().snapshot();
        let focused = control_window(&state);
        let active = focused
            .as_ref()
            .and_then(|w| state.active_tab(w.as_str()))
            .map(|t| t.id.to_string());
        let live = self.bridge.lock().tabs.len();
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "engine": format!("{:?}", self.backend()).to_lowercase(),
            "started": self.is_started(),
            "shuttingDown": self.is_shutting_down(),
            "windows": state.windows.values().filter(|w| w.kind.has_tabs()).count(),
            "tabs": state.tabs.len(),
            "liveTabs": live,
            "profiles": state.profiles.len(),
            "focusedWindow": focused.map(|w| w.to_string()),
            "activeTab": active,
        })
    }

    fn control_tabs(&self) -> Value {
        let state = self.store().snapshot();
        let rows: Vec<Value> = state
            .window_order
            .iter()
            .filter_map(|id| state.window(id.as_str()))
            .filter(|w| w.kind.has_tabs() && w.kind != ardia_state::windows::WindowKind::Incognito)
            .flat_map(|w| {
                let active = w.active_tab().cloned();
                w.tab_ids
                    .iter()
                    .filter_map(|id| state.tab(id.as_str()))
                    .filter(|tab| !tab.is_incognito() && !tab.live.peek)
                    .map(|tab| {
                        json!({
                            "id": tab.id.as_str(),
                            "window": w.id.as_str(),
                            "profile": tab.profile_id.as_str(),
                            "url": tab.url,
                            "title": tab.display_title(),
                            "active": active.as_ref() == Some(&tab.id),
                            "pinned": tab.is_pinned(),
                            "loading": tab.live.loading,
                            "canGoBack": tab.live.can_go_back,
                            "live": self.engine_tab(&tab.id).is_some(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        Value::Array(rows)
    }
}

#[cfg(unix)]
pub mod socket {
    use std::io::{self, BufRead, BufReader, Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc::{RecvTimeoutError, sync_channel};
    use std::sync::{Arc, Weak};
    use std::thread::JoinHandle;
    use std::time::Duration;

    use serde_json::{Value, json};

    use super::ControlError;
    use crate::coordinator::AppCoordinator;

    pub const MAX_LINE: usize = 1024 * 1024;
    pub const MAX_CONNECTIONS: usize = 8;
    pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);
    pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
    const MAX_SOCKET_PATH: usize = 100;
    const ACCEPT_BACKOFF: Duration = Duration::from_millis(50);

    pub struct ControlServer {
        path: PathBuf,
        identity: Option<(u64, u64)>,
        stop: Arc<AtomicBool>,
        wake: Option<UnixStream>,
        thread: Option<JoinHandle<()>>,
    }

    fn identity(path: &Path) -> Option<(u64, u64)> {
        std::fs::symlink_metadata(path)
            .ok()
            .filter(|meta| meta.file_type().is_socket())
            .map(|meta| (meta.dev(), meta.ino()))
    }

    impl std::fmt::Debug for ControlServer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("ControlServer")
                .field("path", &self.path)
                .finish()
        }
    }

    fn claim(path: &Path) -> io::Result<UnixListener> {
        if path.as_os_str().len() > MAX_SOCKET_PATH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the data folder's path is too long for a control socket",
            ));
        }
        if let Ok(meta) = std::fs::symlink_metadata(path) {
            if !meta.file_type().is_socket() {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "something that isn't a control socket has the socket's name, so it stays",
                ));
            }
            let stale = Some((meta.dev(), meta.ino()));
            if UnixStream::connect(path).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another Ardia already answers on this control socket",
                ));
            }
            if identity(path) != stale {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "the control socket changed while Ardia checked it, so it stays",
                ));
            }
            std::fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(listener)
    }

    impl ControlServer {
        pub fn start(path: PathBuf, coordinator: &Arc<AppCoordinator>) -> io::Result<Self> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let listener = claim(&path)?;
            let identity = identity(&path);
            let (wake, woken) = UnixStream::pair()?;
            listener.set_nonblocking(true)?;
            let stop = Arc::new(AtomicBool::new(false));
            let weak = Arc::downgrade(coordinator);
            let thread = std::thread::Builder::new()
                .name("ardia-control".into())
                .spawn({
                    let stop = stop.clone();
                    move || accept_loop(listener, woken, weak, stop)
                })?;
            log::info!("control socket at {}", path.display());
            Ok(Self {
                identity,
                path,
                stop,
                wake: Some(wake),
                thread: Some(thread),
            })
        }

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for ControlServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            drop(self.wake.take());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            if self.identity.is_some() && identity(&self.path) == self.identity {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }

    fn wait_for_clients(listener: &UnixListener, woken: &UnixStream) -> bool {
        let mut fds = [
            libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: woken.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        loop {
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) };
            if ready >= 0 {
                break;
            }
            if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return false;
            }
        }
        fds[1].revents == 0 && fds[0].revents & libc::POLLIN != 0
    }

    fn next_client(listener: &UnixListener) -> Option<UnixStream> {
        loop {
            match listener.accept() {
                Ok((stream, _)) => return stream.set_nonblocking(false).is_ok().then_some(stream),
                Err(problem) if problem.kind() == io::ErrorKind::Interrupted => {}
                Err(problem) if problem.kind() == io::ErrorKind::WouldBlock => return None,
                Err(problem) => {
                    log::debug!("the control socket couldn't take a client: {problem}");
                    std::thread::sleep(ACCEPT_BACKOFF);
                    return None;
                }
            }
        }
    }

    fn accept_loop(
        listener: UnixListener,
        woken: UnixStream,
        coordinator: Weak<AppCoordinator>,
        stop: Arc<AtomicBool>,
    ) {
        let open = Arc::new(AtomicUsize::new(0));
        while !stop.load(Ordering::Acquire) && wait_for_clients(&listener, &woken) {
            while let Some(stream) = next_client(&listener) {
                if stop.load(Ordering::Acquire) {
                    return;
                }
                admit(stream, &open, &coordinator, &stop);
            }
        }
    }

    fn admit(
        stream: UnixStream,
        open: &Arc<AtomicUsize>,
        coordinator: &Weak<AppCoordinator>,
        stop: &Arc<AtomicBool>,
    ) {
        if open.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS {
            open.fetch_sub(1, Ordering::AcqRel);
            let mut stream = stream;
            let _ = writeln!(
                stream,
                "{}",
                json!({"id": null, "error": {"code": "busy", "message": "too many connections"}})
            );
            return;
        }
        let coordinator = coordinator.clone();
        let stop = stop.clone();
        let counted = open.clone();
        let spawned = std::thread::Builder::new()
            .name("ardia-control-client".into())
            .spawn(move || {
                serve(stream, &coordinator, &stop);
                counted.fetch_sub(1, Ordering::AcqRel);
            });
        if spawned.is_err() {
            open.fetch_sub(1, Ordering::AcqRel);
        }
    }

    fn read_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> io::Result<bool> {
        line.clear();
        let read = reader.take(MAX_LINE as u64 + 1).read_until(b'\n', line)?;
        if read == 0 {
            return Ok(false);
        }
        if line.len() > MAX_LINE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the request is too long",
            ));
        }
        Ok(true)
    }

    fn reply(id: Value, answer: Result<Value, ControlError>) -> Value {
        match answer {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => {
                json!({ "id": id, "error": { "code": error.code, "message": error.message } })
            }
        }
    }

    pub fn answer_line(line: &[u8], coordinator: &Weak<AppCoordinator>) -> Value {
        let request: Value = match serde_json::from_slice(line) {
            Ok(request) => request,
            Err(problem) => {
                return reply(
                    Value::Null,
                    Err(ControlError::new("bad_json", problem.to_string())),
                );
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let Some(method) = request
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return reply(
                id,
                Err(ControlError::new("bad_request", "a request needs a method")),
            );
        };
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let Some(coordinator) = coordinator.upgrade() else {
            return reply(
                id,
                Err(ControlError::new("stopped", "Ardia is shutting down")),
            );
        };
        let (sender, receiver) = sync_channel(1);
        coordinator.post(move |coordinator| {
            let _ = sender.send(coordinator.answer_control(&method, &params));
        });
        drop(coordinator);
        let answer = match receiver.recv_timeout(ANSWER_TIMEOUT) {
            Ok(answer) => answer,
            Err(RecvTimeoutError::Timeout) => Err(ControlError::new(
                "timeout",
                "Ardia didn't answer in time; the request may still run",
            )),
            Err(RecvTimeoutError::Disconnected) => Err(ControlError::new(
                "stopped",
                "Ardia stopped before answering",
            )),
        };
        reply(id, answer)
    }

    fn serve(stream: UnixStream, coordinator: &Weak<AppCoordinator>, stop: &AtomicBool) {
        let _ = stream.set_read_timeout(Some(IDLE_TIMEOUT));
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            if stop.load(Ordering::Acquire) {
                return;
            }
            match read_line(&mut reader, &mut line) {
                Ok(true) => {}
                Ok(false) => return,
                Err(problem) => {
                    if problem.kind() == io::ErrorKind::InvalidData {
                        let answer = reply(
                            Value::Null,
                            Err(ControlError::new("too_long", problem.to_string())),
                        );
                        let _ = writeln!(writer, "{answer}");
                    }
                    return;
                }
            }
            let trimmed = line.trim_ascii();
            if trimmed.is_empty() {
                continue;
            }
            let answer = answer_line(trimmed, coordinator);
            if writeln!(writer, "{answer}")
                .and_then(|()| writer.flush())
                .is_err()
            {
                return;
            }
        }
    }
}
