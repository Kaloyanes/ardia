import { ardiaError } from "@ardia/core";
import { orWarn } from "../../lib/fallback";
import { applySafari, emptyCounts, importBookmarks, untitledLinks, type ImportKind, type SafariExport } from "./apply";
import { finishImport, importNow, importSignal, inRun, NO_EXTENSIONS, patchImport, startProgress, updateStatus } from "./flow";
import { importModule } from "./importApi";
import { claimRead, claimSettle, liveTurn, ownsTurn, readingNow, releaseRead, STALE, whileOwned, type ImportTurn } from "./importTurn";
import { settleSource } from "./runImport";
import { consentToken } from "../telemetry/client";
import { noteUntitledBookmarks } from "../telemetry/importRuns";

export const openFullDiskAccessSettings = () => void importModule().openFullDiskAccessSettings();

const safariTurn = (): ImportTurn | null => {
  const turn = importNow().step.name === "safari" ? liveTurn() : null;
  return turn && !readingNow(turn) ? turn : null;
};

export async function pickSafariExport() {
  const turn = safariTurn();
  if (!turn) return;
  const path = await whileOwned(turn, importModule().chooseImportFile("safariExport")).catch(orWarn(null));
  if (path === STALE || !path || importNow().step.name !== "safari") return;
  await readSafari(turn, "export", path);
}

export function importSafariExport(path: string) {
  const turn = safariTurn();
  return turn ? readSafari(turn, "export", path) : Promise.resolve();
}

export function importSafariDirect() {
  const turn = safariTurn();
  return turn ? readSafari(turn, "direct", "") : Promise.resolve();
}

const EXPORT_STATUS = { bookmarks: "active", history: "active", passwords: "active", autofill: "active" } as const;

async function readSafari(turn: ImportTurn, how: "export" | "direct", path: string) {
  if (!claimRead(turn)) return;
  const { target, safariCookies } = importNow();
  const cookies = how === "direct" && safariCookies;
  const multi = inRun(importNow());
  const api = importModule();
  startProgress(how === "export" ? EXPORT_STATUS : { bookmarks: "active", history: "active", tabs: "active", ...(cookies ? { cookies: "active" as const } : {}) }, 1);
  let data: SafariExport | typeof STALE;
  try {
    data = await whileOwned(turn, how === "export" ? api.importSafariExport(path, { signal: turn.signal }) : api.importSafariDirect({ signal: turn.signal }));
  } catch (e) {
    const { code } = ardiaError(e);
    if (!ownsTurn(turn)) return;
    releaseRead(turn);
    if (how === "direct" && code === "cancelled") return;
    const error =
      how === "export"
        ? code === "unsupported"
          ? "Please select a folder or zip file."
          : "The selected file is invalid. Please try again."
        : code === "locked"
          ? "Ardia still doesn't have Full Disk Access. Grant it above, or use the export file below."
          : "Couldn't read Safari's data. Try the export file below.";
    return patchImport({ step: { name: "safari", error }, ...(how === "direct" ? { fullDiskAccess: api.safariHasFullDiskAccess() } : {}) });
  }
  if (data === STALE) return;
  const { consent, signal } = turn;
  const failed: ImportKind[] = [];
  const counts = await applySafari(target, multi ? { ...data, credentials: [] } : data, cookies, (k) => failed.push(k), consent, signal);
  noteUntitledBookmarks(untitledLinks(data.bookmarks), consent);
  const state = (k: ImportKind) => (failed.includes(k) ? "failed" : "done");
  updateStatus(signal, () =>
    how === "export"
      ? { bookmarks: "done", history: state("history"), passwords: "done", autofill: state("autofill") }
      : { bookmarks: "done", history: state("history"), tabs: "done", ...(cookies ? { cookies: state("cookies") } : {}) },
  );
  const failures = failed.map((kind) => ({ kind, profiles: [] }));
  const { source } = importNow();
  if (!multi || !source) {
    if (claimSettle(turn)) finishImport(signal, { counts, failures, notes: [], extensions: NO_EXTENSIONS });
    return;
  }
  const outcome = { source: { id: source.id, name: source.name, family: source.family }, counts, failures, notes: [], extensions: { profileId: "", found: [], groups: [] }, engines: [], skipped: false, consent };
  await settleSource(turn, outcome, data.credentials.length ? [{ profileId: target, credentials: data.credentials, native: null }] : []);
}

export async function importBookmarksHtml() {
  const api = importModule();
  const signal = importSignal();
  const consent = consentToken();
  const path = await api.chooseImportFile("bookmarksHTML");
  if (!path || signal.aborted) return;
  try {
    const root = await api.importBookmarksHTML(path);
    const failed: ImportKind[] = [];
    const bookmarks = await importBookmarks(importNow().target, root, "HTML File", consent, (kind) => failed.push(kind));
    if (signal.aborted) return;
    noteUntitledBookmarks(untitledLinks(root), consent);
    const failures = failed.map((kind) => ({ kind, profiles: [] }));
    patchImport({ source: null, picked: [], step: { name: "done", counts: { ...emptyCounts(), bookmarks }, failures, notes: [], extensions: NO_EXTENSIONS } });
  } catch {
    if (!signal.aborted) patchImport({ step: { name: "choose", error: "The selected file is invalid. Please try again." } });
  }
}
