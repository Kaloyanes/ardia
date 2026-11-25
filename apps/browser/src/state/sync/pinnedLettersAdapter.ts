import type { Adapter, Extraction } from "../../platform/sync";
import type { Tab } from "../browser/types";
import { PIN_TAB, PIN_LETTERS } from "./pinRecords";
import { commitPinnedEdit, homeWindow, store, windowsHomeFirst } from "./pinnedSyncState";
import { pinKeyOf } from "../browser/model";
import { cleanTileLetters } from "../../lib/tileLetter";

const NO_LETTERS = "";

export function pinnedLettersAdapter(profileId: string): Adapter {
  const keyOf = (k: string) => k.slice(PIN_LETTERS.length);
  return {
    prefix: PIN_LETTERS,
    extract: (base) => {
      const s = store();
      const values = new Map<string, unknown>();
      const known = new Set<string>();
      const offer = (key: string, letters: string | undefined) => {
        if (known.has(key)) return;
        known.add(key);
        const k = `${PIN_LETTERS}${key}`;
        if (letters) values.set(k, letters);
        else if (base(k) !== undefined) values.set(k, NO_LETTERS);
      };
      for (const w of windowsHomeFirst(s, homeWindow(s, profileId))) {
        for (const id of w.tabIds) {
          const t = s.tabs[id];
          if (t?.profileId === profileId && t.pin) offer(pinKeyOf(t), t.tileLetters);
        }
      }
      for (const p of s.parkedPins[profileId]?.tabs ?? []) if (!p.groupId) offer(p.id, p.tileLetters);
      return { values, ignore: (k) => !known.has(keyOf(k)) && base(`${PIN_TAB}${keyOf(k)}`) === undefined } satisfies Extraction;
    },
    apply: (visible, changed) => {
      const incoming = new Map<string, string | undefined>();
      for (const k of changed) incoming.set(keyOf(k), cleanTileLetters(visible.get(k)) ?? undefined);
      if (!incoming.size) return true;
      const s = store();
      let tabs: Record<string, Tab> | null = null;
      for (const t of Object.values(s.tabs)) {
        if (t.profileId !== profileId || !t.pin || !incoming.has(pinKeyOf(t))) continue;
        const letters = incoming.get(pinKeyOf(t));
        if (letters !== t.tileLetters) (tabs ??= { ...s.tabs })[t.id] = { ...t, tileLetters: letters };
      }
      const park = s.parkedPins[profileId];
      const parked = park?.tabs.map((p) => (p.groupId || !incoming.has(p.id) || incoming.get(p.id) === p.tileLetters ? p : { ...p, tileLetters: incoming.get(p.id) }));
      const parkEdited = !!park && parked!.some((p, i) => p !== park.tabs[i]);
      if (!tabs && !parkEdited) return true;
      commitPinnedEdit(s, profileId, tabs ? { tabs } : {}, parkEdited ? { tabs: parked! } : null);
      return true;
    },
  };
}
