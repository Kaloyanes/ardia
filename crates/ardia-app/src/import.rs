use std::path::{Path, PathBuf};

use ardia_import_core::{BookmarkNode, NodeType};
use ardia_state::ProfileId;
use ardia_state::import::{BookmarkSource, import_bookmarks_bytes, import_chromium_profile};
use ardia_state::windows::ToastKind;
use serde_json::{Value, json};

use crate::coordinator::AppCoordinator;

pub const MAX_IMPORTED_NODES: usize = 50_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportSource {
    ChromiumProfile { label: String, path: PathBuf },
    BookmarksFile { path: PathBuf },
}

impl ImportSource {
    pub fn label(&self) -> String {
        match self {
            Self::ChromiumProfile { label, .. } => label.clone(),
            Self::BookmarksFile { path } => path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "a bookmarks file".into()),
        }
    }
}

fn browser_folder(name: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match name {
        "chrome" => (
            "Chrome",
            "Google/Chrome/Default",
            ".config/google-chrome/Default",
        ),
        "chromium" => ("Chromium", "Chromium/Default", ".config/chromium/Default"),
        "brave" => (
            "Brave",
            "BraveSoftware/Brave-Browser/Default",
            ".config/BraveSoftware/Brave-Browser/Default",
        ),
        "edge" => (
            "Edge",
            "Microsoft Edge/Default",
            ".config/microsoft-edge/Default",
        ),
        "vivaldi" => ("Vivaldi", "Vivaldi/Default", ".config/vivaldi/Default"),
        "arc" => ("Arc", "Arc/User Data/Default", ".config/arc/Default"),
        "dia" => ("Dia", "Dia/User Data/Default", ".config/dia/Default"),
        _ => return None,
    })
}

pub fn resolve_source(source: &str, home: Option<&Path>) -> Result<ImportSource, String> {
    if let Some(path) = source.strip_prefix("chromium:") {
        return Ok(ImportSource::ChromiumProfile {
            label: "Chromium".into(),
            path: PathBuf::from(path),
        });
    }
    if let Some(path) = source.strip_prefix("html:") {
        return Ok(ImportSource::BookmarksFile {
            path: PathBuf::from(path),
        });
    }
    let (label, mac, linux) =
        browser_folder(source).ok_or_else(|| format!("Ardia can't import from {source:?} yet"))?;
    let home = home.ok_or("there's no home folder to look in")?;
    let path = if cfg!(target_os = "macos") {
        home.join("Library/Application Support").join(mac)
    } else {
        home.join(linux)
    };
    Ok(ImportSource::ChromiumProfile {
        label: label.into(),
        path,
    })
}

pub fn read_source(source: &ImportSource) -> Result<BookmarkNode, String> {
    match source {
        ImportSource::ChromiumProfile { path, .. } => {
            import_chromium_profile(path).map_err(|e| e.to_string())
        }
        ImportSource::BookmarksFile { path } => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let kind = if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
            {
                BookmarkSource::Chromium
            } else {
                BookmarkSource::NetscapeHtml
            };
            import_bookmarks_bytes(kind, &bytes).map_err(|e| e.to_string())
        }
    }
}

fn web_link(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["http://", "https://", "file://", "ftp://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

pub fn bookmark_ops(root: &BookmarkNode, label: &str) -> (Vec<Value>, usize) {
    fn walk(node: &BookmarkNode, parent: &str, ops: &mut Vec<Value>, links: &mut usize) {
        for child in node.children.iter().flatten() {
            if ops.len() >= MAX_IMPORTED_NODES {
                return;
            }
            let id = uuid::Uuid::new_v4().to_string();
            match child.node_type {
                NodeType::Folder => {
                    ops.push(json!({"op": "add", "id": id, "parent": parent, "k": "f", "t": child.title}));
                    walk(child, &id, ops, links);
                }
                NodeType::Url => {
                    let Some(url) = child.url.as_deref().filter(|url| web_link(url)) else {
                        continue;
                    };
                    ops.push(json!({"op": "add", "id": id, "parent": parent, "u": url, "t": child.title}));
                    *links += 1;
                }
            }
        }
    }
    let folder = uuid::Uuid::new_v4().to_string();
    let mut ops = vec![json!({
        "op": "add",
        "id": folder,
        "parent": "other",
        "k": "f",
        "t": format!("Imported from {label}"),
    })];
    let mut links = 0;
    walk(root, &folder, &mut ops, &mut links);
    (ops, links)
}

pub fn start(coordinator: &AppCoordinator, source: String, profile: ProfileId) {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let resolved = resolve_source(&source, home.as_deref());
    let me = coordinator.weak();
    let spawned = std::thread::Builder::new()
        .name("ardia-import".into())
        .spawn(move || {
            let read = resolved.and_then(|source| read_source(&source).map(|tree| (source, tree)));
            if let Some(coordinator) = me.upgrade() {
                coordinator.post(move |coordinator| coordinator.finish_import(profile, read));
            }
        });
    if let Err(problem) = spawned {
        log::warn!("the import couldn't start: {problem}");
    }
}

impl AppCoordinator {
    pub fn finish_import(
        &self,
        profile: ProfileId,
        read: Result<(ImportSource, BookmarkNode), String>,
    ) {
        let (source, tree) = match read {
            Ok(found) => found,
            Err(problem) => {
                self.notify(ToastKind::Error, format!("Nothing was imported: {problem}"));
                return;
            }
        };
        let label = source.label();
        let (ops, links) = bookmark_ops(&tree, &label);
        let (Some(engine), Some(folder)) = (
            self.engine(),
            self.resolve_profile(&profile)
                .and_then(|_| self.service_profile_dir(&profile)),
        ) else {
            self.notify(
                ToastKind::Error,
                format!("The bookmarks from {label} didn't import: the profile isn't open"),
            );
            return;
        };
        let reply = engine.call_service(
            "ac_bookmarks_apply",
            &folder,
            &json!({ "ops": ops }).to_string(),
        );
        let me = self.weak();
        self.spawn(async move {
            let applied = reply.await;
            let Some(me) = me.upgrade() else {
                return;
            };
            match applied {
                Ok(_) => me.notify(
                    ToastKind::Info,
                    format!("Imported {links} bookmarks from {label}"),
                ),
                Err(problem) => me.notify(
                    ToastKind::Error,
                    format!("The bookmarks from {label} didn't import: {problem}"),
                ),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_resolve_to_profiles_and_files() {
        let home = Path::new("/Users/x");
        match resolve_source("chrome", Some(home)).unwrap() {
            ImportSource::ChromiumProfile { label, path } => {
                assert_eq!(label, "Chrome");
                assert!(path.ends_with("Default"));
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            resolve_source("html:/tmp/b.html", None).unwrap(),
            ImportSource::BookmarksFile {
                path: PathBuf::from("/tmp/b.html")
            }
        );
        assert!(resolve_source("netscape", Some(home)).is_err());
        assert!(resolve_source("chrome", None).is_err());
    }

    #[test]
    fn trees_become_engine_ops_under_one_folder() {
        let tree = BookmarkNode::folder(
            "root",
            vec![
                BookmarkNode::link("A", "https://a.example", None),
                BookmarkNode::link("Script", "javascript:alert(1)", None),
                BookmarkNode::folder(
                    "Work",
                    vec![BookmarkNode::link("B", "https://b.example", None)],
                    None,
                ),
            ],
            None,
        );
        let (ops, links) = bookmark_ops(&tree, "Chrome");
        assert_eq!(links, 2, "only web links import");
        assert_eq!(ops.len(), 4);
        assert_eq!(ops[0]["parent"], "other");
        assert_eq!(ops[0]["t"], "Imported from Chrome");
        let work = ops.iter().find(|op| op["t"] == "Work").unwrap();
        let b = ops.iter().find(|op| op["t"] == "B").unwrap();
        assert_eq!(b["parent"], work["id"]);
        assert!(ops.iter().all(|op| op["op"] == "add"));
    }

    #[test]
    fn html_files_import() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bookmarks.html");
        std::fs::write(
            &path,
            "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p><DT><A HREF=\"https://x.example/\">X</A></DL><p>",
        )
        .unwrap();
        let tree = read_source(&ImportSource::BookmarksFile { path }).unwrap();
        assert_eq!(tree.link_count(), 1);
    }
}
