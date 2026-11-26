import { ardiaError } from "@ardia/core";
import { applySafari, emptyCounts, importBookmarks, untitledLinks, type ImportCounts, type ImportKind, type SafariExport } from "./apply";
import { finishImport, importNow, importSignal, inRun, NO_EXTENSIONS, patchImport, startProgress, updateStatus } from "./flow";
import { importModule } from "./importApi";
import { collectLogins } from "./importOutcome";
import { settleSource } from "./runImport";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteUntitledBookmarks } from "../telemetry/importRuns";

export const chooseSafariExport = () => importModule().chooseImportFile("safariExport");
export const openFullDiskAccessSettings = () => void importModule().openFullDiskAccessSettings();

function withLoginsHeld(target: string, data: SafariExport): SafariExport {
  const { source } = importNow();
  if (!source || !inRun(importNow()) || !data.credentials.length) return data;
  collectLogins(source.id, target, data.credentials);
  return { ...data, credentials: [] };
}

function settleSafari(signal: AbortSignal, counts: ImportCounts, failed: ImportKind[], consent: ConsentToken | null) {
  const failures = failed.map((kind) => ({ kind, profiles: [] }));
  const { source } = importNow();
  if (!source || !inRun(importNow())) return finishImport(signal, { counts, failures, notes: [], extensions: NO_EXTENSIONS });
  void settleSource(
    { source: { id: source.id, name: source.name, family: source.family }, counts, failures, notes: [], extensions: { profileId: "", found: [], groups: [] }, engines: [], skipped: false },
    consent,
  );
}

export async function importSafariExport(path: string) {
  const consent = consentToken();
  const { target } = importNow();
  const signal = importSignal();
  startProgress({ bookmarks: "active", history: "active", passwords: "active", autofill: "active" }, 1);
  try {
    const data = await importModule().importSafariExport(path);
    const failed: ImportKind[] = [];
    const counts = await applySafari(target, withLoginsHeld(target, data), false, (k) => failed.push(k), consent);
    noteUntitledBookmarks(untitledLinks(data.bookmarks), consent);
    updateStatus(signal, () => ({ bookmarks: "done", history: failed.includes("history") ? "failed" : "done", passwords: "done", autofill: failed.includes("autofill") ? "failed" : "done" }));
    settleSafari(signal, counts, failed, consent);
  } catch (e) {
    if (signal.aborted) return;
    patchImport({ step: { name: "safari", error: ardiaError(e).code === "unsupported" ? "Please select a folder or zip file." : "The selected file is invalid. Please try again." } });
  }
}

export async function importSafariDirect() {
  const consent = consentToken();
  const { target, safariCookies } = importNow();
  const signal = importSignal();
  const api = importModule();
  startProgress({ bookmarks: "active", history: "active", tabs: "active", ...(safariCookies ? { cookies: "active" as const } : {}) }, 1);
  try {
    const data = await api.importSafariDirect({ signal });
    const failed: ImportKind[] = [];
    const counts = await applySafari(target, withLoginsHeld(target, data), safariCookies, (k) => failed.push(k), consent);
    noteUntitledBookmarks(untitledLinks(data.bookmarks), consent);
    updateStatus(signal, () => ({ bookmarks: "done", history: failed.includes("history") ? "failed" : "done", tabs: "done", ...(safariCookies ? { cookies: failed.includes("cookies") ? "failed" : ("done" as const) } : {}) }));
    settleSafari(signal, counts, failed, consent);
  } catch (e) {
    const { code } = ardiaError(e);
    if (code === "cancelled" || signal.aborted) return;
    patchImport({
      step: {
        name: "safari",
        error: code === "locked" ? "Ardia still doesn't have Full Disk Access. Grant it above, or use the export file below." : "Couldn't read Safari's data. Try the export file below.",
      },
      fullDiskAccess: api.safariHasFullDiskAccess(),
    });
  }
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
