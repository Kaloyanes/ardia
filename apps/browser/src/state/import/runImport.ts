import { AppState } from "react-native";
import { orWarn } from "../../lib/fallback";
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
  spacesOf,
  startImport,
  startRun,
  takeTurn,
  waitsForAccess,
  type ImportStepName,
  type SourceOutcome,
} from "./flow";
import { importModule } from "./importApi";
import { collectLogins, discardLogins, finishRun, finishSource, forgetCollectedLogins, type HeldLogins } from "./importOutcome";
import { runImportJob } from "./importSource";
import { claimRead, claimSettle, endTurn, liveTurn, ownsTurn, readingNow, releaseRead, STALE, startTurn as startTurnIn, whileOwned, type ImportTurn } from "./importTurn";
import { during } from "../app/jobActivity";

let runConsent: ConsentToken | null = null;

const startTurn = (consent: ConsentToken | null) => startTurnIn(consent, importSignal());

export function openImportSession(delayBeforeDone: number): () => void {
  forgetCollectedLogins();
  endTurn();
  const stop = startImport(delayBeforeDone);
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active" && waitsForAccess(importNow())) void recheckAccess();
  });
  return () => {
    stop();
    appState.remove();
    endTurn();
    forgetCollectedLogins();
  };
}

const turnFor = (consent: ConsentToken | null) => liveTurn() ?? startTurn(consent);

export async function recheckAccess() {
  const { step } = importNow();
  if (step.name === "safari") return patchImport({ fullDiskAccess: importModule().safariHasFullDiskAccess() });
  const turn = liveTurn();
  if (step.name !== "access" || !turn || readingNow(turn)) return;
  const list = await whileOwned(turn, importModule().listBrowsers()).catch(orWarn(null));
  if (list === STALE || !list || importNow().step.name !== "access") return;
  const flow = importNow();
  const several = inRun(flow);
  patchImport({ browsers: several ? flow.browsers.map((b) => list.find((x) => x.id === b.id) ?? b) : list });
  const updated = list.find((b) => b.id === flow.source?.id);
  if (!updated || updated.needsFullDiskAccess) return;
  if (!several) {
    endTurn();
    return chooseSource(updated);
  }
  takeTurn(updated);
  proceed("choose", turn);
}

export function continueImport(from: "choose" | "profiles") {
  const flow = importNow();
  if (flow.step.name !== from) return;
  if (from === "choose" && flow.picked.length > 1) {
    const consent = consentToken();
    forgetCollectedLogins();
    if (!startRun()) return;
    runConsent = consent;
    return beginTurn();
  }
  const turn = from === "choose" ? startTurn(consentToken()) : turnFor(consentToken());
  if (readingNow(turn)) return;
  proceed(from, turn);
}

function beginTurn() {
  const turn = startTurn(runConsent);
  const { run, browsers } = importNow();
  if (!run) return;
  const id = run.ids[run.at]!;
  const browser = browsers.find((b) => b.id === id);
  if (!browser) return void settleSource(turn, skippedOutcome({ id, name: id, family: "chromium" }));
  takeTurn(browser);
  proceed("choose", turn);
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

const SKIPPABLE: ImportStepName[] = ["access", "safari", "profiles"];

export function skipSource() {
  const flow = importNow();
  const turn = liveTurn();
  if (!flow.source || !turn || !inRun(flow) || !SKIPPABLE.includes(flow.step.name) || readingNow(turn)) return;
  void settleSource(turn, skippedOutcome(flow.source));
}

export async function settleSource(turn: ImportTurn, settled: SourceOutcome, logins: HeldLogins = []): Promise<boolean> {
  if (!claimSettle(turn)) {
    discardLogins(logins);
    return false;
  }
  const { signal, consent } = turn;
  const outcome = { ...settled, consent };
  const { run } = importNow();
  if (!run || run.ids.length < 2) {
    discardLogins(logins);
    await finishSource(outcome, consent, signal);
    return true;
  }
  collectLogins(outcome.source.id, consent, logins);
  const outcomes = [...run.outcomes, outcome];
  if (run.at + 1 < run.ids.length) {
    if (importNow().step.name === "progress") await pauseForDoneDelay();
    if (signal.aborted) return true;
    patchImport({ run: { ...run, at: run.at + 1, outcomes } });
    beginTurn();
    return true;
  }
  patchImport({ run: { ...run, outcomes } });
  await finishRun(outcomes, signal);
  return true;
}

function proceed(from: ImportStepName, turn: ImportTurn) {
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
  void importIn(turn, kinds, false);
}

const stillUnlocking = (turn: ImportTurn) => {
  const { step } = importNow();
  return ownsTurn(turn) && step.name === "unlock" && step.unlocking;
};

export async function unlockAndImport() {
  const { source, step } = importNow();
  if (!source || step.name !== "unlock" || step.unlocking) return;
  const turn = turnFor(consentToken());
  if (readingNow(turn)) return;
  patchImport({ step: { name: "unlock", unlocking: true, error: step.error } });
  let unlocked: unknown;
  try {
    unlocked = await whileOwned(turn, importModule().unlockBrowser(source.id));
  } catch {
    if (stillUnlocking(turn))
      patchImport({ step: { name: "unlock", unlocking: false, error: `macOS didn't allow access to ${source.name}'s keychain item. Try again, or skip the encrypted data.` } });
    return;
  }
  if (unlocked !== STALE && stillUnlocking(turn)) void importIn(turn, importNow().kinds, false);
}

export function skipEncryptedData() {
  const { step, kinds: chosen } = importNow();
  if (step.name !== "unlock") return;
  const turn = turnFor(consentToken());
  if (readingNow(turn)) return;
  const kinds = new Set(chosen);
  kinds.delete("passwords");
  kinds.delete("cookies");
  patchImport({ kinds });
  void importIn(turn, kinds, true);
}

export const runImport = (wanted: ReadonlySet<ImportKind>, withoutKey = false) => importIn(turnFor(consentToken()), wanted, withoutKey);

const importIn = (turn: ImportTurn, wanted: ReadonlySet<ImportKind>, withoutKey: boolean) => during("import", () => importAndSettle(turn, wanted, withoutKey));

async function importAndSettle(turn: ImportTurn, wanted: ReadonlySet<ImportKind>, withoutKey: boolean) {
  const { source } = importNow();
  if (!source || !claimRead(turn)) return;
  const job = { source, wanted, withoutKey, consent: turn.consent, signal: turn.signal, collecting: inRun(importNow()) };
  const read = job.collecting
    ? await runImportJob(job).catch(() => ({ outcome: brokenOutcome(source, wanted), logins: [] }))
    : await runImportJob(job);
  if (read) return void (await settleSource(turn, read.outcome, read.logins));
  releaseRead(turn);
}

function brokenOutcome(source: BrowserSource, wanted: ReadonlySet<ImportKind>): SourceOutcome {
  return { ...skippedOutcome(source), skipped: false, failures: IMPORT_KINDS.filter((k) => wanted.has(k)).map((kind) => ({ kind, profiles: [] })) };
}
