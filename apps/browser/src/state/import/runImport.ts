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
import { collectLogins, finishRun, finishSource, forgetCollectedLogins, type HeldLogins } from "./importOutcome";
import { runImportJob } from "./importSource";
import { claimRead, currentTurn, nextTurn, ownsTurn, releaseRead, type ImportTurn } from "./importTurn";
import { during } from "../app/jobActivity";

export function openImportSession(delayBeforeDone: number): () => void {
  forgetCollectedLogins();
  nextTurn();
  const stop = startImport(delayBeforeDone);
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active" && waitsForAccess(importNow())) void recheckAccess();
  });
  return () => {
    stop();
    appState.remove();
    forgetCollectedLogins();
    nextTurn();
  };
}

export async function recheckAccess() {
  const held = currentTurn();
  const updated = await refreshedAccess();
  if (!updated || !ownsTurn(held) || importNow().step.name !== "access") return;
  if (!inRun(importNow())) return chooseSource(updated);
  takeTurn(updated);
  proceed("choose");
}

export function continueImport() {
  const flow = importNow();
  if (flow.step.name !== "choose" && flow.step.name !== "profiles") return;
  if (flow.step.name === "choose" && flow.picked.length > 1) {
    forgetCollectedLogins();
    if (startRun()) beginTurn();
    return;
  }
  proceed(flow.step.name);
}

function beginTurn() {
  nextTurn();
  const { run, browsers } = importNow();
  if (!run) return;
  const id = run.ids[run.at]!;
  const browser = browsers.find((b) => b.id === id);
  if (!browser) return void settleSource(skippedOutcome({ id, name: id, family: "chromium" }), consentToken(), currentTurn());
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
  consent: null,
});

export function skipSource() {
  const { source } = importNow();
  if (source && inRun(importNow())) void settleSource(skippedOutcome(source), consentToken(), currentTurn());
}

export async function settleSource(settled: SourceOutcome, consent: ConsentToken | null, held: ImportTurn, logins: HeldLogins = []) {
  if (!ownsTurn(held)) return;
  nextTurn();
  const { signal } = held;
  const outcome = { ...settled, consent };
  const { run } = importNow();
  if (!run || run.ids.length < 2) return finishSource(outcome, consent, signal);
  for (const l of logins) collectLogins(outcome.source.id, l.profileId, l.credentials);
  const outcomes = [...run.outcomes, outcome];
  if (run.at + 1 < run.ids.length) {
    if (importNow().step.name === "progress") await pauseForDoneDelay();
    if (signal.aborted) return;
    patchImport({ run: { ...run, at: run.at + 1, outcomes } });
    return beginTurn();
  }
  patchImport({ run: { ...run, outcomes } });
  return finishRun(outcomes, signal);
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

const stillUnlocking = (held: ImportTurn) => {
  const { step } = importNow();
  return ownsTurn(held) && step.name === "unlock" && step.unlocking;
};

export async function unlockAndImport() {
  const { source, step } = importNow();
  if (!source || (step.name === "unlock" && step.unlocking)) return;
  const held = currentTurn();
  patchImport({ step: { name: "unlock", unlocking: true, error: step.name === "unlock" ? step.error : null } });
  try {
    await importModule().unlockBrowser(source.id);
  } catch {
    if (stillUnlocking(held))
      patchImport({ step: { name: "unlock", unlocking: false, error: `macOS didn't allow access to ${source.name}'s keychain item. Try again, or skip the encrypted data.` } });
    return;
  }
  if (stillUnlocking(held)) void runImport(importNow().kinds);
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
  const held = claimRead();
  if (!held) return;
  const consent = consentToken();
  const read = inRun(importNow())
    ? await runImportJob(source, wanted, withoutKey, consent, true).catch(() => ({ outcome: brokenOutcome(source, wanted), logins: [] }))
    : await runImportJob(source, wanted, withoutKey, consent, false);
  if (read) return settleSource(read.outcome, consent, held, read.logins);
  releaseRead(held);
}

function brokenOutcome(source: BrowserSource, wanted: ReadonlySet<ImportKind>): SourceOutcome {
  return { ...skippedOutcome(source), skipped: false, failures: IMPORT_KINDS.filter((k) => wanted.has(k)).map((kind) => ({ kind, profiles: [] })) };
}
