use super::*;

impl Tx<'_> {
    pub(super) fn create_group(
        &mut self,
        tabs: &[TabId],
        name: &str,
    ) -> Result<GroupId, ActionError> {
        let tabs = &self.with_split_partners(tabs.to_vec());
        let first = self.require_listed_tab(
            tabs.first()
                .ok_or(ActionError::Invalid("a group needs at least one tab"))?,
        )?;
        let members: Vec<TabId> = tabs
            .iter()
            .filter(|t| {
                self.is_listed(t)
                    && self.s.tabs.get(*t).is_some_and(|t| {
                        t.window_id == first.window_id
                            && t.profile_id == first.profile_id
                            && t.pin.is_none()
                    })
            })
            .cloned()
            .collect();
        if members.is_empty() {
            return Err(ActionError::Invalid("pinned tabs can't join a group"));
        }
        if first.profile_id.is_incognito() && false {
            return Err(ActionError::Invalid("unreachable"));
        }
        let id = self.ids.group();
        let mut group = TabGroup::new(
            id.clone(),
            first.window_id.clone(),
            first.profile_id.clone(),
            Vec::new(),
            self.now,
        );
        group.name = name.trim().to_owned();
        let order = self
            .s
            .windows
            .get(&first.window_id)
            .map(|w| w.tab_ids.clone())
            .unwrap_or_default();
        group.tab_ids = order
            .iter()
            .filter(|t| members.contains(t))
            .cloned()
            .collect();
        if let Some(parent) = self
            .s
            .group_of(members[0].as_str())
            .filter(|g| members.iter().all(|m| g.tab_ids.contains(m)))
        {
            group.parent_id = Some(parent.id.clone());
            group.pinned = parent.pinned;
        } else {
            let gone: HashSet<TabId> = members.iter().cloned().collect();
            let left = groups::leave_groups(&self.s.groups, &gone);
            if left != *self.s.groups {
                self.set_groups(left);
            }
        }
        Arc::make_mut(&mut self.s.groups).insert(id.clone(), Arc::new(group));
        self.out.changes.note(Topics::GROUPS, false);
        push_unique(&mut self.out.changes.groups, &id);
        let block: Vec<TabId> = order
            .iter()
            .filter(|t| members.contains(t))
            .cloned()
            .collect();
        if let Some(w) = self.window_mut(&first.window_id) {
            w.tab_ids = groups::place_block(&w.tab_ids, &block);
        }
        self.reorder_window(&first.window_id);
        self.out.group = Some(id.clone());
        Ok(id)
    }

    pub(super) fn close_group(&mut self, group: &GroupId) -> Result<(), ActionError> {
        let mut g = self
            .s
            .groups
            .get(group)
            .cloned()
            .ok_or_else(|| ActionError::NoGroup(group.to_string()))?;
        let mut walked: HashSet<GroupId> = HashSet::from([g.id.clone()]);
        while let Some(parent) = g
            .parent_id
            .as_ref()
            .and_then(|p| self.s.groups.get(p))
            .filter(|p| p.tab_ids.len() == g.tab_ids.len() && walked.insert(p.id.clone()))
        {
            g = Arc::clone(parent);
        }
        let tabs: Vec<TabSnapshot> = g
            .tab_ids
            .iter()
            .filter_map(|t| self.s.tabs.get(t))
            .map(|t| t.snapshot())
            .collect();
        let private = self
            .s
            .windows
            .get(&g.window_id)
            .is_some_and(|w| w.kind == WindowKind::Incognito);
        if !private && tabs.iter().any(|t| !t.url.is_empty()) {
            let nested = groups::descendants(&self.s.groups, g.id.as_str())
                .iter()
                .filter_map(|id| self.s.groups.get(id))
                .map(|c| crate::closed::NestedGroupSnapshot {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    icon: c.icon.clone(),
                    color: c.color,
                    collapsed: c.collapsed,
                    parent_id: c.parent_id.clone().unwrap_or_default(),
                    tab_indexes: c
                        .tab_ids
                        .iter()
                        .filter_map(|t| g.tab_ids.iter().position(|m| m == t))
                        .collect(),
                })
                .collect();
            let engine_ids = g
                .tab_ids
                .iter()
                .filter_map(|t| self.s.tabs.get(t))
                .map(|t| {
                    t.page
                        .pending_restore()
                        .map_or_else(|| t.id.to_string(), str::to_owned)
                })
                .collect();
            let entry = ClosedGroup {
                kind: crate::closed::ClosedKind::Group,
                id: self.ids.entry("cg"),
                group: ClosedGroup::header_of(&g),
                tabs,
                tab_ids: Some(engine_ids),
                nested,
                window_id: g.window_id.clone(),
                index: self
                    .s
                    .windows
                    .get(&g.window_id)
                    .and_then(|w| {
                        g.tab_ids
                            .first()
                            .and_then(|f| w.tab_ids.iter().position(|t| t == f))
                    })
                    .unwrap_or(0),
                profile_index: g
                    .tab_ids
                    .first()
                    .and_then(|f| self.s.profile_index(&g.window_id, &g.profile_id, f)),
                closed_at: self.now,
                extra: Default::default(),
            };
            self.closed_mut().push_group(entry);
        }
        let members = g.tab_ids.clone();
        if let Some(w) = self.s.windows.get(&g.window_id).cloned() {
            let all_gone = w
                .tab_ids
                .iter()
                .filter(|t| {
                    self.s
                        .tabs
                        .get(*t)
                        .is_some_and(|t| t.profile_id == w.profile_id)
                })
                .all(|t| members.contains(t));
            if all_gone {
                self.new_tab(
                    &w.id,
                    NewTab {
                        background: true,
                        ..NewTab::default()
                    },
                )?;
            }
        }
        self.remove_tabs(&members, false);
        Ok(())
    }

    pub(super) fn restore_group(
        &mut self,
        entry: &ClosedGroup,
        requested: Option<&WindowId>,
    ) -> Result<GroupId, ActionError> {
        self.closed_mut().remove(entry.id.as_str());
        let usable = |w: &&Arc<BrowserWindow>| w.kind == WindowKind::Main;
        let window = match self
            .s
            .windows
            .get(&entry.window_id)
            .filter(usable)
            .or_else(|| requested.and_then(|r| self.s.windows.get(r)).filter(usable))
            .map(|w| w.id.clone())
            .or_else(|| self.s.main_window_for(None).cloned())
        {
            Some(w) => w,
            None => self.open_window(
                WindowKind::Main,
                entry.tabs.first().map(|t| t.profile_id.clone()),
                None,
                None,
            )?,
        };
        let shown = self.s.windows[&window].profile_id.clone();
        let profile = entry
            .tabs
            .first()
            .map(|t| t.profile_id.clone())
            .filter(|p| self.s.profiles.contains_key(p))
            .unwrap_or(shown);
        let start = (window == entry.window_id)
            .then(|| {
                entry.profile_index.map_or(Some(entry.index), |pi| {
                    self.index_for_profile_index(&window, &profile, pi)
                })
            })
            .flatten();
        let mut made = Vec::with_capacity(entry.tabs.len());
        for (i, snap) in entry.tabs.iter().enumerate() {
            let id = self.new_tab(
                &window,
                NewTab {
                    background: true,
                    index: start.map(|at| at + i),
                    ..NewTab::restoring(TabSnapshot {
                        pin: None,
                        profile_id: profile.clone(),
                        ..snap.clone()
                    })
                },
            )?;
            let wake = entry
                .tab_ids
                .as_ref()
                .and_then(|ids| ids.get(i))
                .filter(|_| !snap.url.is_empty())
                .map(|key| crate::model::restore_id(&TabId::new(key)));
            if let Some(t) = self.tab_mut(&id) {
                t.page = TabPage {
                    kind: PageKind::Idle,
                    wake,
                };
                t.unseen = false;
            }
            made.push(id);
        }
        if made.is_empty() {
            return Err(ActionError::Invalid("the group had no tabs"));
        }
        let fresh = |taken: &groups::Groups, id: &GroupId, ids: &IdGen| {
            if taken.contains_key(id) {
                ids.group()
            } else {
                id.clone()
            }
        };
        let mut groups = (*self.s.groups).clone();
        let gid = fresh(&groups, &entry.group.id, self.ids);
        let parent = entry.group.parent_id.clone().filter(|p| {
            groups
                .get(p)
                .is_some_and(|g| g.window_id == window && g.profile_id == profile)
        });
        let mut root = TabGroup::new(
            gid.clone(),
            window.clone(),
            profile.clone(),
            made.clone(),
            self.now,
        );
        root.name = entry.group.name.clone();
        root.icon = entry.group.icon.clone();
        root.color = entry.group.color;
        root.pinned = entry.group.pinned;
        root.parent_id = parent;
        let pinned = root.pinned;
        groups.insert(gid.clone(), Arc::new(root));
        let mut renamed: Vec<(GroupId, GroupId)> = vec![(entry.group.id.clone(), gid.clone())];
        for n in &entry.nested {
            let Some(parent) = renamed
                .iter()
                .find(|(old, _)| *old == n.parent_id)
                .map(|(_, new)| new.clone())
            else {
                continue;
            };
            let members: Vec<TabId> = n
                .tab_indexes
                .iter()
                .filter_map(|i| made.get(*i).cloned())
                .collect();
            if members.is_empty() {
                continue;
            }
            let id = fresh(&groups, &n.id, self.ids);
            let mut child = TabGroup::new(
                id.clone(),
                window.clone(),
                profile.clone(),
                members,
                self.now,
            );
            child.name = n.name.clone();
            child.icon = n.icon.clone();
            child.color = n.color;
            child.collapsed = n.collapsed;
            child.pinned = pinned;
            child.parent_id = Some(parent);
            renamed.push((n.id.clone(), id.clone()));
            groups.insert(id, Arc::new(child));
        }
        self.set_groups(groups);
        self.reorder_window(&window);
        self.activate(&made[0]);
        self.out.group = Some(gid.clone());
        Ok(gid)
    }

    pub(super) fn update_group(
        &mut self,
        group: GroupId,
        patch: GroupPatch,
    ) -> Result<(), ActionError> {
        let g = self
            .group_mut(&group)
            .ok_or_else(|| ActionError::NoGroup(group.to_string()))?;
        if let Some(name) = patch.name {
            g.name = name.trim().to_owned();
        }
        if let Some(icon) = patch.icon {
            g.icon = icon;
        }
        if let Some(color) = patch.color {
            g.color = color;
        }
        if let Some(collapsed) = patch.collapsed {
            g.collapsed = collapsed;
        }
        let window = g.window_id.clone();
        if let Some(pinned) = patch.pinned {
            let root =
                groups::root(&self.s.groups, group.as_str()).unwrap_or_else(|| group.clone());
            let tree: Vec<GroupId> = std::iter::once(root.clone())
                .chain(groups::descendants(&self.s.groups, root.as_str()))
                .collect();
            for id in tree {
                if let Some(g) = self.group_mut(&id) {
                    g.pinned = pinned;
                }
            }
            self.reorder_window(&window);
        }
        Ok(())
    }

    pub(super) fn add_to_group(
        &mut self,
        group: GroupId,
        tabs: Vec<TabId>,
    ) -> Result<(), ActionError> {
        let tabs = self.with_split_partners(tabs);
        let g = self
            .s
            .groups
            .get(&group)
            .cloned()
            .ok_or_else(|| ActionError::NoGroup(group.to_string()))?;
        let joining: Vec<TabId> = tabs
            .into_iter()
            .filter(|t| {
                self.is_listed(t)
                    && self.s.tabs.get(t).is_some_and(|tab| {
                        tab.window_id == g.window_id
                            && tab.profile_id == g.profile_id
                            && tab.pin.is_none()
                    })
                    && !g.tab_ids.contains(t)
            })
            .collect();
        let mut next = groups::leave_groups(&self.s.groups, &joining.iter().cloned().collect());
        let Some(target) = next.get_mut(&group) else {
            return Err(ActionError::NoGroup(group.to_string()));
        };
        Arc::make_mut(target)
            .tab_ids
            .extend(joining.iter().cloned());
        self.set_groups(next);
        let order = self
            .s
            .windows
            .get(&g.window_id)
            .map(|w| w.tab_ids.clone())
            .unwrap_or_default();
        let members = self.s.groups[&group].tab_ids.clone();
        let block: Vec<TabId> = order
            .iter()
            .filter(|t| members.contains(t))
            .cloned()
            .collect();
        if let Some(w) = self.window_mut(&g.window_id) {
            w.tab_ids = groups::place_block(&w.tab_ids, &block);
        }
        self.reorder_window(&g.window_id);
        Ok(())
    }

    pub(super) fn remove_from_groups(&mut self, tabs: Vec<TabId>) -> Result<(), ActionError> {
        let mut leaving: IndexMap<GroupId, Vec<TabId>> = IndexMap::new();
        for tab in self.with_split_partners(tabs) {
            if let Some(group) = self.s.group_of(tab.as_str()) {
                leaving.entry(group.id.clone()).or_default().push(tab);
            }
        }
        for (group, out) in leaving {
            let Some(g) = self.s.groups.get(&group).cloned() else {
                continue;
            };
            let kept: Vec<TabId> = g
                .tab_ids
                .iter()
                .filter(|t| !out.contains(t))
                .cloned()
                .collect();
            let mut next = (*self.s.groups).clone();
            match kept.last().cloned() {
                Some(last) => {
                    Arc::make_mut(next.get_mut(&group).expect("group")).tab_ids = kept;
                    if let Some(w) = self.window_mut(&g.window_id) {
                        let moving: Vec<TabId> = w
                            .tab_ids
                            .iter()
                            .filter(|t| out.contains(t))
                            .cloned()
                            .collect();
                        w.tab_ids.retain(|t| !out.contains(t));
                        let at = w
                            .tab_ids
                            .iter()
                            .position(|t| *t == last)
                            .map_or(w.tab_ids.len(), |i| i + 1);
                        w.tab_ids.splice(at..at, moving);
                    }
                }
                None => {
                    let was = next.clone();
                    next.shift_remove(&group);
                    groups::reparent(&mut next, &was);
                }
            }
            self.set_groups(next);
            self.reorder_window(&g.window_id);
        }
        Ok(())
    }

    pub(super) fn ungroup(&mut self, group: GroupId) -> Result<(), ActionError> {
        let g = self
            .s
            .groups
            .get(&group)
            .cloned()
            .ok_or_else(|| ActionError::NoGroup(group.to_string()))?;
        let mut groups = (*self.s.groups).clone();
        groups.shift_remove(&group);
        let snapshot = (*self.s.groups).clone();
        groups::reparent(&mut groups, &snapshot);
        self.set_groups(groups);
        self.reorder_window(&g.window_id);
        Ok(())
    }
}
