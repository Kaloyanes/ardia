import type { SettingsMeta } from "./settings";

type RetiredDefault = { key: string; old: unknown; applied: string };

export const TOOLBAR_SCROLL_DEFAULT_APPLIED = "hideToolbarWhileScrolling:offByDefault";
export const CMD_CLICK_GROUPS_DEFAULT_APPLIED = "cmdClickCreatesTabGroup:offByDefault";

export const RETIRED_DEFAULTS: readonly RetiredDefault[] = [
  { key: "hideToolbarWhileScrolling", old: true, applied: TOOLBAR_SCROLL_DEFAULT_APPLIED },
  { key: "cmdClickCreatesTabGroup", old: true, applied: CMD_CLICK_GROUPS_DEFAULT_APPLIED },
];

type Retired<S> = { settings: S | undefined; settingsMeta: SettingsMeta };

function withRetiredDefault<S extends object>({ settings: saved, settingsMeta: meta }: Retired<S>, { key, old, applied }: RetiredDefault): Retired<S> {
  if (meta.inferred.includes(applied)) return { settings: saved, settingsMeta: meta };
  const marked = (m: SettingsMeta): SettingsMeta => ({ chosen: m.chosen, inferred: [...m.inferred, applied] });
  const untouchedOld = !!saved && (saved as Record<string, unknown>)[key] === old && !(meta.chosen.includes(key) && !meta.inferred.includes(key));
  if (!untouchedOld) return { settings: saved, settingsMeta: marked(meta) };
  const { [key]: _untouched, ...settings } = saved as Record<string, unknown>;
  const without = (keys: string[]) => keys.filter((k) => k !== key);
  return { settings: settings as S, settingsMeta: marked({ chosen: without(meta.chosen), inferred: without(meta.inferred) }) };
}

export const withRetiredDefaults = <S extends object>(saved: S | undefined, meta: SettingsMeta): Retired<S> =>
  RETIRED_DEFAULTS.reduce<Retired<S>>(withRetiredDefault, { settings: saved, settingsMeta: meta });
