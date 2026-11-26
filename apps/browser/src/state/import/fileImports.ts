import { ardiaError } from "@ardia/core";
import { applySafari, emptyCounts, importBookmarks, untitledLinks, type ImportKind, type SafariExport } from "./apply";
import { finishImport, importNow, importSignal, inRun, NO_EXTENSIONS, patchImport, startProgress, updateStatus } from "./flow";
import { importModule } from "./importApi";
import { claimRead, nextTurn, ownsTurn, releaseRead, type ImportTurn } from "./importTurn";
import { settleSource } from "./runImport";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteUntitledBookmarks } from "../telemetry/importRuns";

export const chooseSafariExport = () => importModule().chooseImportFile("safariExport");
export const openFullDiskAccessSettings = () => void importModule().openFullDiskAccessSettings();

type SafariRead = { held: ImportTurn; consent: ConsentToken | null; target: string; multi: boolean };

function startSafariRead(status: Parameters<typeof startProgress>[0]): SafariRead | null {
  const held = claimRead();
  if (!held) return null;
  const consent = consentToken();
  const { target } = importNow();
  startProgress(status, 1);
  return { held, consent, target, multi: inRun(importNow()) };
}

async function applySafariRead(read: SafariRead, data: SafariExport, cookies: boolean, done: (failed: ImportKind[]) => Parameters<typeof updateStatus>[1]) {
  const { held, consent, target, multi } = read;
  const failed: ImportKind[] = [];
  const counts = await applySafari(target, multi ? { ...data, credentials: [] } : data, cookies, (k) => failed.push(k), consent);
  noteUntitledBookmarks(untitledLinks(data.bookmarks), consent);
  updateStatus(held.signal, done(failed));
  const failures = failed.map((kind) => ({ kind, profiles: [] }));
  const { source } = importNow();
  if (!multi || !source) {
    nextTurn();
    return finishImport(held.signal, { counts, failures, notes: [], extensions: NO_EXTENSIONS });
  }
  const outcome = { source: { id: source.id, name: source.name, family: source.family }, counts, failures, notes: [], extensions: { profileId: "", found: [], groups: [] }, engines: [], skipped: false, consent };
  await settleSource(outcome, consent, held, data.credentials.length ? [{ profileId: target, credentials: data.credentials }] : []);
}

function safariFailed(held: ImportTurn, step: { error: string; fullDiskAccess?: boolean }) {
  if (!ownsTurn(held)) return;
  releaseRead(held);
  patchImport({ step: { name: "safari", error: step.error }, ...(step.fullDiskAccess === undefined ? {} : { fullDiskAccess: step.fullDiskAccess }) });
}

export async function importSafariExport(path: string) {
  const read = startSafariRead({ bookmarks: "active", history: "active", passwords: "active", autofill: "active" });
  if (!read) return;
  let data: SafariExport;
  try {
    data = await importModule().importSafariExport(path);
  } catch (e) {
    return safariFailed(read.held, { error: ardiaError(e).code === "unsupported" ? "Please select a folder or zip file." : "The selected file is invalid. Please try again." });
  }
  if (!ownsTurn(read.held)) return;
  await applySafariRead(read, data, false, (failed) => () => ({ bookmarks: "done", history: failed.includes("history") ? "failed" : "done", passwords: "done", autofill: failed.includes("autofill") ? "failed" : "done" }));
}

export async function importSafariDirect() {
  const { safariCookies } = importNow();
  const read = startSafariRead({ bookmarks: "active", history: "active", tabs: "active", ...(safariCookies ? { cookies: "active" as const } : {}) });
  if (!read) return;
  const api = importModule();
  let data: SafariExport;
  try {
    data = await api.importSafariDirect({ signal: read.held.signal });
  } catch (e) {
    const { code } = ardiaError(e);
    if (code === "cancelled") return releaseRead(read.held);
    return safariFailed(read.held, {
      error: code === "locked" ? "Ardia still doesn't have Full Disk Access. Grant it above, or use the export file below." : "Couldn't read Safari's data. Try the export file below.",
      fullDiskAccess: api.safariHasFullDiskAccess(),
    });
  }
  if (!ownsTurn(read.held)) return;
  await applySafariRead(read, data, safariCookies, (failed) => () => ({
    bookmarks: "done",
    history: failed.includes("history") ? "failed" : "done",
    tabs: "done",
    ...(safariCookies ? { cookies: failed.includes("cookies") ? "failed" : ("done" as const) } : {}),
  }));
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
