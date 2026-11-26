import { orWarn } from "../../lib/fallback";
import { useBrowser } from "../browser/store";
import type { ConsentToken } from "../telemetry/client";
import { noteMultiImport } from "../telemetry/importRuns";
import { emptyCounts, saveLogins, type Credential, type ImportCounts, type ImportedExtension } from "./apply";
import { finishImport, importNow, patchImport, showAfterDoneDelay, type ConflictChoiceSet, type ImportFailure, type SourceOutcome, type SourceTally } from "./flow";
import { listFoundExtensions } from "./listedExtensions";
import {
  changedChoices,
  choicesFor,
  planLogins,
  resolutionOf,
  resolvedLogins,
  type CollectedLogin,
  type ConflictPick,
  type ConflictResolution,
  type LoginPlan,
  type LoginToSave,
} from "./passwordConflicts";
import { adoptImportedEngine } from "./searchEngine";

const collected: CollectedLogin[] = [];
let unresolvedRun: { outcomes: SourceOutcome[]; plan: LoginPlan; consent: ConsentToken | null; signal: AbortSignal } | null = null;

export function collectLogins(browserId: string, profileId: string, credentials: readonly Credential[]) {
  for (const credential of credentials) collected.push({ browserId, profileId, credential });
}

export function forgetCollectedLogins() {
  collected.length = 0;
  unresolvedRun = null;
}

const dismissBookmarksOffer = (counts: ImportCounts) => {
  if (counts.bookmarks > 0) useBrowser.getState().updateSettings({ bookmarksImportDismissed: true });
};

export async function finishSource(outcome: SourceOutcome, consent: ConsentToken | null, signal: AbortSignal) {
  dismissBookmarksOffer(outcome.counts);
  const listing = await listFoundExtensions(outcome.extensions.groups, consent).catch(orWarn(null));
  if (signal.aborted) return;
  const engine = adoptImportedEngine(outcome.source, outcome.engines, consent);
  finishImport(signal, {
    counts: outcome.counts,
    failures: outcome.failures,
    notes: outcome.notes,
    extensions: { profileId: outcome.extensions.profileId, list: outcome.extensions.found, opened: false, listing },
    searchEngine: engine?.notice ?? undefined,
  });
}

export async function finishRun(outcomes: SourceOutcome[], consent: ConsentToken | null, signal: AbortSignal) {
  const plan = planLogins(collected.splice(0), outcomes.map((o) => o.source.id));
  if (!plan.conflicts.length) return completeRun(outcomes, plan, resolvedLogins(plan, {}), null, 0, consent, signal);
  unresolvedRun = { outcomes, plan, consent, signal };
  const none: ConflictChoiceSet = { choices: {}, base: {} };
  showAfterDoneDelay(signal, { name: "conflicts", conflicts: plan.conflicts, pick: "newest", custom: null, view: "summary", draft: none, filter: "", saving: false });
}

const adoptable = (o: SourceOutcome) => !o.skipped && (o.source.family === "chromium" || o.source.family === "arc") && o.engines.length > 0;

function addCounts(into: ImportCounts, from: ImportCounts) {
  for (const k of Object.keys(into) as (keyof ImportCounts)[]) into[k] += from[k];
}

async function completeRun(
  outcomes: SourceOutcome[],
  plan: LoginPlan,
  logins: LoginToSave[],
  resolution: ConflictResolution | null,
  changedByHand: number,
  consent: ConsentToken | null,
  signal: AbortSignal,
) {
  const saved = await saveLogins(logins);
  if (signal.aborted) return;
  const imported = outcomes.filter((o) => !o.skipped);
  const tallies: SourceTally[] = imported.map((o) => ({ id: o.source.id, name: o.source.name, counts: { ...o.counts } }));
  logins.forEach((l, i) => {
    const tally = tallies.find((t) => t.id === l.browserId);
    if (saved[i] && tally) tally.counts.passwords += 1;
  });
  const total = emptyCounts();
  for (const t of tallies) addCounts(total, t.counts);
  dismissBookmarksOffer(total);
  const listing = await listFoundExtensions(imported.flatMap((o) => o.extensions.groups), consent).catch(orWarn(null));
  if (signal.aborted) return;
  const offering = imported.find((o) => adoptable(o) && o.engines.some((e) => e.engine)) ?? imported.find(adoptable);
  const engine = offering ? adoptImportedEngine(offering.source, offering.engines, consent) : null;
  const found = new Map<string, ImportedExtension>();
  for (const o of imported) for (const e of o.extensions.found) if (!found.has(e.id)) found.set(e.id, e);
  noteMultiImport(
    { browsers: outcomes.length, skipped: outcomes.length - imported.length, conflicts: plan.conflicts.length, merged: plan.merged, resolution, changedByHand },
    consent,
  );
  const failures: ImportFailure[] = imported.flatMap((o) => o.failures.map((f) => ({ ...f, browser: o.source.name })));
  const notes = [
    ...outcomes.filter((o) => o.skipped).map((o) => `${o.source.name} was skipped.`),
    ...imported.flatMap((o) => o.notes.map((n) => `${o.source.name}: ${n}`)),
  ];
  finishImport(signal, {
    counts: total,
    failures,
    notes,
    extensions: { profileId: imported.map((o) => o.extensions.profileId).find(Boolean) ?? "", list: [...found.values()], opened: false, listing },
    searchEngine: engine?.notice ?? undefined,
    sources: tallies,
    ...(engine?.notice && offering ? { engineFrom: offering.source.name } : {}),
  });
}

const conflictStep = () => {
  const { step } = importNow();
  return step.name === "conflicts" ? step : null;
};

type ConflictStep = NonNullable<ReturnType<typeof conflictStep>>;

export function currentChoices(step: ConflictStep): Record<string, string> {
  if (step.view === "list") return step.draft.choices;
  if (step.pick === "custom" && step.custom) return step.custom.choices;
  return choicesFor(step.conflicts, step.pick);
}

export const handChanges = (set: ConflictChoiceSet | null) => (set ? changedChoices(set.base, set.choices) : 0);

export function pickConflictVersions(pick: ConflictPick) {
  const step = conflictStep();
  if (!step || step.saving || (pick === "custom" && !step.custom)) return;
  patchImport({ step: { ...step, pick, view: "summary" } });
}

export function openConflictList() {
  const step = conflictStep();
  if (!step || step.saving || step.view === "list") return;
  const choices = currentChoices(step);
  const base = step.pick === "custom" && step.custom ? step.custom.base : choices;
  patchImport({ step: { ...step, view: "list", draft: { choices, base }, filter: "" } });
}

export function setConflictFilter(filter: string) {
  const step = conflictStep();
  if (step?.view === "list") patchImport({ step: { ...step, filter } });
}

export function chooseConflictVersion(id: string, browserId: string) {
  const step = conflictStep();
  const conflict = step?.conflicts.find((c) => c.id === id);
  if (!step || step.view !== "list" || !conflict?.versions.some((v) => v.browserId === browserId)) return;
  patchImport({ step: { ...step, draft: { ...step.draft, choices: { ...step.draft.choices, [id]: browserId } } } });
}

export function chooseAllConflicts(browserId: string) {
  const step = conflictStep();
  if (!step || step.view !== "list") return;
  const choices = Object.fromEntries(step.conflicts.map((c) => [c.id, c.versions.some((v) => v.browserId === browserId) ? browserId : step.draft.choices[c.id]!]));
  patchImport({ step: { ...step, draft: { ...step.draft, choices } } });
}

export function closeConflictList() {
  const step = conflictStep();
  if (!step || step.view !== "list") return;
  patchImport({ step: { ...step, view: "summary", pick: "custom", custom: step.draft } });
}

export async function importChosenPasswords() {
  const step = conflictStep();
  if (!step || step.saving || !unresolvedRun) return;
  const custom = step.view === "list" ? step.draft : step.pick === "custom" ? step.custom : null;
  const pick: ConflictPick = step.view === "list" ? "custom" : step.pick;
  const choices = currentChoices(step);
  const { outcomes, plan, consent, signal } = unresolvedRun;
  unresolvedRun = null;
  patchImport({ step: { ...step, saving: true } });
  await completeRun(outcomes, plan, resolvedLogins(plan, choices), resolutionOf(pick), handChanges(custom), consent, signal);
}
