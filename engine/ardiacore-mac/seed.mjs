#!/usr/bin/env node
import { session } from "../../scripts/lib/instance.mjs";

export const PROFILES = [
  { name: "Personal", id: "default", tabs: 150, selected: 130 },
  { name: "Work", id: "work", tabs: 15, selected: 12 },
  { name: "Play", id: "play", tabs: 5, selected: 2 },
];

export const WINDOW_FRAME = [60, 60, 1360, 820];

export function benchSession(origin) {
  const tabs = PROFILES.flatMap((p) =>
    Array.from({ length: p.tabs }, (_, n) => ({
      id: `${p.id}-t${n}`,
      profileId: p.id,
      url: `${origin}/${p.id}/tab${n}`,
      title: `${p.name} tab ${n + 1}`,
      lastActiveAt: n + 1,
    })),
  );
  const s = session({
    profiles: PROFILES.map(({ name, id }) => ({ name, id })),
    windows: [{ id: "main", frame: WINDOW_FRAME, sidebarOpen: true }],
    tabs,
  });
  s.windows[0].tabIds = tabs.map((t) => t.id);
  s.windows[0].activeTabIds = Object.fromEntries(PROFILES.map((p) => [p.id, `${p.id}-t${p.selected}`]));
  s.settings = { searchSuggestions: false, warnBeforeClosingLastTab: false, warnBeforeClosingWindow: false, restoreSession: true };
  return s;
}

export function webuiSession(origin) {
  const s = benchSession(origin);
  return {
    ...s,
    windows: Object.fromEntries(s.windows.map((w) => [w.id, { ...w, kind: "main" }])),
    tabs: Object.fromEntries(s.tabs.map((t) => [t.id, { ...t, pin: null, page: { kind: "idle" } }])),
    groups: {},
    splits: {},
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind = "webui", origin = "http://127.0.0.1:9600"] = process.argv.slice(2);
  console.log(JSON.stringify(kind === "rn" ? benchSession(origin) : webuiSession(origin)));
}
