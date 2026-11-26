import { AppState } from "react-native";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { emptyCounts, type BrowserSource, type ImportKind } from "./apply";
import {
  chooseSource,
  DIA_SIDEBAR_KINDS,
  ENCRYPTED_KINDS,
  importNow,
  IMPORT_KINDS,
  importSignal,
  importsBySpaces,
  inRun,
  patchImport,
  pauseForDoneDelay,
  refreshedAccess,
  spacesOf,
  startImport,
  startRun,
  takeTurn,
  waitsForAccess,
  type ImportStepName,
  type SourceOutcome,
} from "./flow";
import { importModule } from "./importApi";
import { finishRun, finishSource, forgetCollectedLogins } from "./importOutcome";
import { runImportJob } from "./importSource";
import { during } from "../app/jobActivity";

export function openImportSession(delayBeforeDone: number): () => void {
  forgetCollectedLogins();
  const stop = startImport(delayBeforeDone);
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active" && waitsForAccess(importNow())) void recheckAccess();
  });
  return () => {
    stop();
    appState.remove();
    forgetCollectedLogins();
  };
}

export async function recheckAccess() {
  const updated = await refreshedAccess();
  if (!updated) return;
  if (!inRun(importNow())) return chooseSource(updated);
  takeTurn(updated);
  proceed("choose");
}

export function continueImport() {
  const flow = importNow();
  if (flow.step.name === "choose" && flow.picked.length > 1) {
    forgetCollectedLogins();
    if (startRun()) beginTurn();
    return;
  }
  proceed(flow.step.name);
}

function beginTurn() {
  const { run, browsers } = importNow();
  if (!run) return;
  const id = run.ids[run.at]!;
  const browser = browsers.find((b) => b.id === id);
  if (!browser) return void settleSource(skippedOutcome({ id, name: id, family: "chromium" }), consentToken());
  takeTurn(browser);
  proceed("choose");
}

const skippedOutcome = (source: SourceOutcome["source"]): SourceOutcome => ({
  source,
  counts: emptyCounts(),
  failures: [],
  notes: [],
  extensions: { profileId: "", found: [], groups: [] },
  engines: [],
  skipped: true,
});

export function skipSource() {
  const { source } = importNow();
  if (source && inRun(importNow())) void settleSource(skippedOutcome(source), consentToken());
}

export async function settleSource(outcome: SourceOutcome, consent: ConsentToken | null) {
  const signal = importSignal();
  if (signal.aborted) return;
  const { run } = importNow();
  if (!run || run.ids.length < 2) return finishSource(outcome, consent, signal);
  const outcomes = [...run.outcomes, outcome];
  if (run.at + 1 < run.ids.length) {
    if (importNow().step.name === "progress") await pauseForDoneDelay();
    if (signal.aborted) return;
    patchImport({ run: { ...run, at: run.at + 1, outcomes } });
    return beginTurn();
  }
  patchImport({ run: { ...run, outcomes } });
  return finishRun(outcomes, consent, signal);
}

function proceed(from: ImportStepName) {
  const { source, kinds, sourceProfiles } = importNow();
  if (!source) return;
  if (from === "choose") {
    if (source.needsFullDiskAccess) return patchImport({ step: { name: "access" } });
    if (source.requiresExport) return patchImport({ step: { name: "safari", error: null } });
    if (source.profiles.length > 1 || (importsBySpaces(source) && spacesOf(source).length > 1)) return patchImport({ step: { name: "profiles" } });
  }
  const sidebarKinds = DIA_SIDEBAR_KINDS.some((k) => kinds.has(k));
  const encryptedTabs = source.profiles.some((p) => sourceProfiles.includes(p.id) && p.tabsNeedKey && (kinds.has("tabs") || (!!p.diaSidebar && sidebarKinds)));
  const locked = (encryptedTabs || ENCRYPTED_KINDS.some((k) => kinds.has(k))) && source.needsKeychain && !importModule().isBrowserUnlocked(source.id);
  if ((from === "choose" || from === "profiles") && locked) return patchImport({ step: { name: "unlock", unlocking: false, error: null } });
  void runImport(kinds);
}

export async function unlockAndImport() {
  const { source, step } = importNow();
  if (!source) return;
  const signal = importSignal();
  patchImport({ step: { name: "unlock", unlocking: true, error: step.name === "unlock" ? step.error : null } });
  try {
    await importModule().unlockBrowser(source.id);
  } catch {
    if (!signal.aborted)
      patchImport({ step: { name: "unlock", unlocking: false, error: `macOS didn't allow access to ${source.name}'s keychain item. Try again, or skip the encrypted data.` } });
    return;
  }
  if (!signal.aborted) void runImport(importNow().kinds);
}

export function skipEncryptedData() {
  const kinds = new Set(importNow().kinds);
  kinds.delete("passwords");
  kinds.delete("cookies");
  patchImport({ kinds });
  void runImport(kinds, true);
}

export const runImport = (wanted: ReadonlySet<ImportKind>, withoutKey = false) => during("import", () => importAndSettle(wanted, withoutKey));

async function importAndSettle(wanted: ReadonlySet<ImportKind>, withoutKey: boolean) {
  const { source } = importNow();
  if (!source) return;
  const consent = consentToken();
  const outcome = inRun(importNow())
    ? await runImportJob(source, wanted, withoutKey, consent, true).catch(() => brokenOutcome(source, wanted))
    : await runImportJob(source, wanted, withoutKey, consent, false);
  if (outcome) await settleSource(outcome, consent);
}

function brokenOutcome(source: BrowserSource, wanted: ReadonlySet<ImportKind>): SourceOutcome {
  return { ...skippedOutcome(source), skipped: false, failures: IMPORT_KINDS.filter((k) => wanted.has(k)).map((kind) => ({ kind, profiles: [] })) };
}
