use super::*;

impl Tx<'_> {
    pub(super) fn create_profile(
        &mut self,
        name: &str,
        color: Option<ProfileColor>,
        icon: Option<String>,
    ) -> Result<ProfileId, ActionError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(ActionError::Invalid("a profile needs a name"));
        }
        let id = self.ids.profile();
        let color = color.unwrap_or_else(|| {
            ProfileColor::NEW_PROFILE_CYCLE
                [self.s.profiles.len() % ProfileColor::NEW_PROFILE_CYCLE.len()]
        });
        let mut profile = Profile::new(id.clone(), name, color, self.now);
        profile.icon = icon;
        Arc::make_mut(&mut self.s.profiles).insert(id.clone(), Arc::new(profile));
        Arc::make_mut(&mut self.s.profile_order).push(id.clone());
        self.out.changes.note(Topics::PROFILES, false);
        push_unique(&mut self.out.changes.profiles, &id);
        self.out.profile = Some(id.clone());
        Ok(id)
    }

    pub(super) fn update_profile(
        &mut self,
        id: &ProfileId,
        patch: ProfilePatch,
    ) -> Result<(), ActionError> {
        let profiles = Arc::make_mut(&mut self.s.profiles);
        let profile = profiles
            .get_mut(id)
            .map(Arc::make_mut)
            .ok_or_else(|| ActionError::NoProfile(id.to_string()))?;
        if let Some(name) = patch
            .name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
        {
            profile.name = name;
        }
        if let Some(color) = patch.color {
            let theme = profile.theme.clone();
            if let (Some(theme), Some(presets)) = (theme, profile.preset_themes.as_mut()) {
                presets.insert(profile.color.key().to_owned(), theme);
            }
            profile.color = ColorChoice::Preset(color);
            profile.theme = profile
                .preset_themes
                .as_ref()
                .and_then(|p| p.get(color.key()).cloned());
            profile.seen_color = Some(profile.color.clone());
            profile.seen_theme = Some(profile.theme.clone());
        }
        if let Some(icon) = patch.icon {
            if icon != profile.icon {
                profile.switcher_dot = false;
            }
            profile.icon = icon;
        }
        if let Some(theme) = patch.theme {
            profile.theme = theme;
            if let Some(presets) = profile.preset_themes.as_mut() {
                match &profile.theme {
                    Some(t) => {
                        presets.insert(profile.color.key().to_owned(), Arc::clone(t));
                    }
                    None => {
                        presets.shift_remove(profile.color.key());
                    }
                }
            }
            profile.seen_theme = Some(profile.theme.clone());
        }
        if let Some(collapsed) = patch.pinned_collapsed {
            profile.pinned_collapsed = Some(collapsed);
        }
        self.out.changes.note(Topics::PROFILES, false);
        push_unique(&mut self.out.changes.profiles, id);
        Ok(())
    }

    pub(super) fn delete_profile(&mut self, id: &ProfileId) -> Result<(), ActionError> {
        if !self.s.profiles.contains_key(id) {
            return Err(ActionError::NoProfile(id.to_string()));
        }
        if self.s.profile_order.len() <= 1 {
            return Err(ActionError::Invalid("the last profile can't be deleted"));
        }
        let private: Vec<WindowId> = self
            .s
            .windows
            .values()
            .filter(|w| w.kind == WindowKind::Incognito && w.profile_id.incognito_original() == *id)
            .map(|w| w.id.clone())
            .collect();
        for w in private {
            self.close_window(&w, false);
        }
        let order: Vec<ProfileId> = self
            .s
            .profile_order
            .iter()
            .filter(|p| *p != id)
            .cloned()
            .collect();
        let fallback = if self.s.settings.default_profile_id == id.as_str() {
            order[0].clone()
        } else {
            ProfileId::new(&self.s.settings.default_profile_id)
        };
        let showing: Vec<Arc<BrowserWindow>> = self
            .s
            .windows
            .values()
            .filter(|w| w.profile_id == *id)
            .cloned()
            .collect();
        for w in showing {
            let other = w
                .tab_ids
                .iter()
                .filter_map(|t| self.s.tabs.get(t))
                .find(|t| t.profile_id != *id)
                .map(|t| {
                    w.active_tab_ids
                        .get(&t.profile_id)
                        .cloned()
                        .unwrap_or_else(|| t.id.clone())
                });
            match other {
                Some(tab) => self.activate(&tab),
                None => {
                    let tab = self.new_tab(
                        &w.id,
                        NewTab {
                            profile: Some(fallback.clone()),
                            background: true,
                            ..NewTab::default()
                        },
                    )?;
                    self.activate(&tab);
                }
            }
        }
        let doomed: Vec<TabId> = self
            .s
            .tabs
            .values()
            .filter(|t| t.profile_id == *id)
            .map(|t| t.id.clone())
            .collect();
        self.remove_tabs(&doomed, false);
        let engine = self.s.engine_profile(id);
        let engine_left = !order.iter().any(|p| self.s.engine_profile(p) == engine);
        if self.s.groups.values().any(|g| g.profile_id == *id) {
            let kept: groups::Groups = self
                .s
                .groups
                .iter()
                .filter(|(_, g)| g.profile_id != *id)
                .map(|(k, g)| (k.clone(), Arc::clone(g)))
                .collect();
            self.set_groups(kept);
        }
        Arc::make_mut(&mut self.s.profiles).shift_remove(id);
        self.s.profile_order = Arc::new(order);
        let stale: Vec<WindowId> = self
            .s
            .windows
            .values()
            .filter(|w| w.active_tab_ids.contains_key(id))
            .map(|w| w.id.clone())
            .collect();
        for w in stale {
            if let Some(w) = self.window_mut(&w) {
                w.active_tab_ids.shift_remove(id);
            }
        }
        let persisted = Arc::make_mut(&mut self.s.persisted);
        persisted.parked_pins.shift_remove(id);
        persisted.pin_choices.shift_remove(id.as_str());
        persisted.pin_sync.shift_remove(id.as_str());
        if engine_left && !persisted.orphaned_profile_data.contains(&engine) {
            persisted.orphaned_profile_data.push(engine.clone());
        }
        if engine_left {
            Arc::make_mut(&mut self.s.history).shift_remove(&engine);
            Arc::make_mut(&mut self.s.bookmarks).shift_remove(&engine);
            self.out
                .changes
                .note(Topics::HISTORY | Topics::BOOKMARKS, false);
        }
        let closed = self.closed_mut();
        closed.tabs.retain(|c| c.tab.profile_id != *id);
        closed.cleaned_tabs.retain(|c| c.tab.profile_id != *id);
        closed
            .groups
            .retain(|c| c.tabs.iter().all(|t| t.profile_id != *id));
        closed
            .deleted_groups
            .retain(|c| c.tabs.iter().all(|t| t.profile_id != *id));
        closed.windows = closed
            .windows
            .iter()
            .filter_map(|c| c.without_profile(id))
            .collect();
        let settings = Arc::make_mut(&mut self.s.settings);
        settings.default_profile_id = fallback.to_string();
        settings.never_translate_sites.shift_remove(id.as_str());
        if self.s.last_profile_id.as_ref() == Some(id) {
            self.s.last_profile_id = Some(fallback);
        }
        let empty: Vec<WindowId> = self
            .s
            .windows
            .values()
            .filter(|w| {
                w.kind.has_tabs()
                    && !w.tab_ids.iter().any(|t| {
                        self.s
                            .tabs
                            .get(t)
                            .is_some_and(|t| t.profile_id == w.profile_id)
                    })
            })
            .map(|w| w.id.clone())
            .collect();
        for w in empty {
            self.new_tab(&w, NewTab::default())?;
        }
        self.out.changes.note(
            Topics::PROFILES | Topics::SETTINGS | Topics::PINS | Topics::FOCUS,
            false,
        );
        push_unique(&mut self.out.changes.profiles, id);
        Ok(())
    }

    pub(super) fn update_settings(&mut self, patch: &SettingsPatch, from_sync: bool) {
        let mut settings = (*self.s.settings).clone();
        let mut meta = (*self.s.settings_meta).clone();
        let applied = settings.apply(&mut meta, patch, from_sync, false);
        if settings == *self.s.settings && meta == *self.s.settings_meta {
            return;
        }
        self.s.settings = Arc::new(settings);
        self.s.settings_meta = Arc::new(meta);
        self.out.changes.note(Topics::SETTINGS, false);
        if applied.auto_hide_changed {
            let overridden: Vec<WindowId> = self
                .s
                .windows
                .values()
                .filter(|w| w.auto_hide_tabs.is_some())
                .map(|w| w.id.clone())
                .collect();
            for id in overridden {
                if let Some(w) = self.window_mut(&id) {
                    w.auto_hide_tabs = None;
                }
            }
        }
    }

    pub(super) fn reorder_profiles(&mut self, order: Vec<ProfileId>) -> Result<(), ActionError> {
        let mut next: Vec<ProfileId> = order
            .into_iter()
            .filter(|p| self.s.profiles.contains_key(p))
            .fold(Vec::new(), |mut acc, p| {
                push_unique(&mut acc, &p);
                acc
            });
        for p in self.s.profile_order.iter() {
            push_unique(&mut next, p);
        }
        self.s.profile_order = Arc::new(next);
        self.out.changes.note(Topics::PROFILES, false);
        Ok(())
    }

    pub(super) fn set_shortcut(
        &mut self,
        id: String,
        shortcut: Option<Shortcut>,
    ) -> Result<(), ActionError> {
        let mut shortcuts = self.s.settings.shortcuts.clone();
        set_override(&mut shortcuts, &id, shortcut.as_ref());
        self.update_settings(&SettingsPatch::new().set("shortcuts", shortcuts), false);
        Ok(())
    }

    pub(super) fn reset_shortcut(&mut self, id: String) -> Result<(), ActionError> {
        let mut shortcuts = self.s.settings.shortcuts.clone();
        reset_override(&mut shortcuts, &id);
        self.update_settings(&SettingsPatch::new().set("shortcuts", shortcuts), false);
        Ok(())
    }
}
