import { hostOf } from "@ardia/core";
import type { Credential } from "../../platform/importModule";
import { originOfLogin } from "../site/savedPasswords";

export type CollectedLogin = { browserId: string; profileId: string; credential: Credential };
export type LoginToSave = { browserId: string; profileId: string; origin: string; username: string; password: string };
export type ConflictVersion = { browserId: string; at: number };
export type PasswordConflict = { id: string; profileId: string; origin: string; site: string; username: string; versions: ConflictVersion[] };
export type ConflictChoices = Readonly<Record<string, string>>;
export type ConflictPick = "newest" | "custom" | (string & {});

export type LoginPlan = {
  clean: LoginToSave[];
  conflicts: PasswordConflict[];
  versions: ReadonlyMap<string, ReadonlyMap<string, LoginToSave>>;
  merged: number;
};

export const loginOrigin = (c: Credential) => originOfLogin(c.realm?.startsWith("http") ? c.realm : c.url);
export const loginAge = (c: Pick<Credential, "created" | "lastUsed">) => Math.max(c.lastUsed ?? 0, c.created ?? 0);

type Held = { login: LoginToSave; at: number };

export function planLogins(collected: readonly CollectedLogin[], order: readonly string[]): LoginPlan {
  const groups = new Map<string, Map<string, Held>>();
  for (const { browserId, profileId, credential } of collected) {
    const origin = loginOrigin(credential);
    if (!origin || !credential.password) continue;
    const key = JSON.stringify([profileId, origin, credential.username]);
    const byBrowser = groups.get(key) ?? new Map<string, Held>();
    const at = loginAge(credential);
    const earlier = byBrowser.get(browserId);
    if (!earlier || at >= earlier.at) byBrowser.set(browserId, { login: { browserId, profileId, origin, username: credential.username, password: credential.password }, at });
    groups.set(key, byBrowser);
  }
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  const clean: LoginToSave[] = [];
  const conflicts: PasswordConflict[] = [];
  const versions = new Map<string, ReadonlyMap<string, LoginToSave>>();
  let merged = 0;
  for (const byBrowser of groups.values()) {
    const held = [...byBrowser.values()].sort((a, b) => rank(a.login.browserId) - rank(b.login.browserId));
    const first = held[0]!;
    if (held.every((h) => h.login.password === first.login.password)) {
      clean.push(first.login);
      merged += held.length - 1;
      continue;
    }
    const id = `conflict-${conflicts.length}`;
    const { profileId, origin, username } = first.login;
    conflicts.push({ id, profileId, origin, site: hostOf(origin) || origin, username, versions: held.map((h) => ({ browserId: h.login.browserId, at: h.at })) });
    versions.set(id, new Map(held.map((h) => [h.login.browserId, h.login])));
  }
  return { clean, conflicts, versions, merged };
}

export const newestVersion = (conflict: PasswordConflict) => conflict.versions.reduce((best, v) => (v.at > best.at ? v : best)).browserId;

export function choicesFor(conflicts: readonly PasswordConflict[], pick: string): Record<string, string> {
  return Object.fromEntries(conflicts.map((c) => [c.id, c.versions.some((v) => v.browserId === pick) ? pick : newestVersion(c)]));
}

export function conflictBrowsers(conflicts: readonly PasswordConflict[], order: readonly string[]): string[] {
  const involved = new Set(conflicts.flatMap((c) => c.versions.map((v) => v.browserId)));
  return order.filter((id) => involved.has(id));
}

export function newerCounts(conflicts: readonly PasswordConflict[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of conflicts) {
    if (c.versions.every((v) => v.at === c.versions[0]!.at)) continue;
    const id = newestVersion(c);
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export const changedChoices = (from: ConflictChoices, to: ConflictChoices) => Object.keys(to).filter((id) => from[id] !== to[id]).length;

export function matchingConflicts(conflicts: readonly PasswordConflict[], filter: string): PasswordConflict[] {
  const text = filter.trim().toLowerCase();
  if (!text) return [...conflicts];
  return conflicts.filter((c) => c.site.toLowerCase().includes(text) || c.username.toLowerCase().includes(text));
}

export function resolvedLogins(plan: LoginPlan, choices: ConflictChoices): LoginToSave[] {
  return [
    ...plan.clean,
    ...plan.conflicts.map((c) => {
      const byBrowser = plan.versions.get(c.id)!;
      return byBrowser.get(choices[c.id] ?? "") ?? byBrowser.get(newestVersion(c))!;
    }),
  ];
}

export type ConflictResolution = "newest" | "browser" | "custom";

export const resolutionOf = (pick: ConflictPick): ConflictResolution => (pick === "newest" ? "newest" : pick === "custom" ? "custom" : "browser");
