#![cfg_attr(not(test), forbid(unsafe_code))]

mod macros;

pub mod actions;
pub mod air_traffic;
pub mod bookmarks;
pub mod closed;
pub mod commands;
pub mod downloads;
pub mod groups;
pub mod history;
pub mod ids;
pub mod import;
pub mod json;
pub mod migration;
pub mod model;
pub mod omnibox;
pub mod persistence;
pub mod profiles;
pub mod settings;
pub mod shortcuts;
pub mod splits;
pub mod state;
pub mod store;
pub mod sync;
pub mod tabs;
pub mod updates;
pub mod windows;

pub use actions::{
    Action, ActionError, ChangeSet, GroupPatch, NewTab, Outcome, PageUpdate, ProfilePatch, Topics,
};
pub use ids::{
    BookmarkId, DownloadId, EntryId, GroupId, IdGen, ProfileId, RuleId, SplitId, TabId, WindowId,
};
pub use model::Millis;
pub use persistence::{DataDir, PersistError};
pub use state::BrowserState;
pub use store::{BrowserStore, Interest, Subscription, Update};

pub fn state_version() -> &'static str {
    ardia_theme::theme_version()
}
