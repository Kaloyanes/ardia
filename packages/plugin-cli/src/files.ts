import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

export const PACK_LIMITS = { files: 4000, fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, packedBytes: 64 * 1024 * 1024, pathBytes: 240 } as const;

export type FileEntry = { path: string; size: number; mode: number; executable: boolean };

export type WalkResult = { files: FileEntry[]; directories: string[]; problems: string[] };

const toPosix = (path: string) => path.split(sep).join("/");

export function insidePath(root: string, rel: string): { ok: true; stats: Stats } | { ok: false; reason: string } {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return { ok: false, reason: "isn't a relative path" };
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return { ok: false, reason: "leaves the plugin's folder" };
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch {
      return { ok: false, reason: "doesn't exist" };
    }
    if (stats.isSymbolicLink()) return { ok: false, reason: "is or goes through a symlink" };
    if (i < parts.length - 1 && !stats.isDirectory()) return { ok: false, reason: "goes through a file" };
    if (i === parts.length - 1) {
      if (!stats.isFile()) return { ok: false, reason: "isn't a regular file" };
      if (stats.nlink > 1) return { ok: false, reason: "is a hard link" };
      return { ok: true, stats };
    }
  }
  return { ok: false, reason: "doesn't exist" };
}

export type IgnoreRule = (path: string, isDirectory: boolean) => boolean;

export function globRule(pattern: string): IgnoreRule {
  const directoryOnly = pattern.endsWith("/");
  const clean = pattern.replace(/\/$/, "").replace(/^\//, "");
  const anchored = pattern.startsWith("/") || clean.includes("/");
  const source = clean.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  const regex = new RegExp(anchored ? `^${source}$` : `(^|/)${source}$`);
  return (path, isDirectory) => (!directoryOnly || isDirectory) && regex.test(path);
}

export const DEFAULT_IGNORES = [
  ".*",
  "node_modules/",
  "/src/",
  "/release/",
  "/test/",
  "/tests/",
  "*.tar.gz",
  "*.tgz",
  "*.sha256",
  "*.map",
  "tsconfig*.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
];

export function walkPluginFiles(root: string, ignore: readonly IgnoreRule[], keep: ReadonlySet<string>): WalkResult {
  const files: FileEntry[] = [];
  const directories: string[] = [];
  const problems: string[] = [];
  const kept = (path: string, isDirectory: boolean) =>
    keep.has(path) || (isDirectory && [...keep].some((k) => k.startsWith(`${path}/`))) || !ignore.some((rule) => rule(path, isDirectory));
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (error) {
      problems.push(`${toPosix(relative(root, dir)) || "."} can't be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = toPosix(relative(root, full));
      const stats = lstatSync(full);
      const isDirectory = stats.isDirectory();
      if (!kept(rel, isDirectory)) continue;
      if (stats.isSymbolicLink()) problems.push(`${rel} is a symlink; packs hold regular files only`);
      else if (isDirectory) {
        directories.push(rel);
        visit(full);
      } else if (!stats.isFile()) problems.push(`${rel} isn't a regular file`);
      else if (stats.nlink > 1) problems.push(`${rel} is a hard link; packs hold regular files only`);
      else files.push({ path: rel, size: stats.size, mode: stats.mode, executable: (stats.mode & 0o100) !== 0 });
    }
  };
  visit(root);
  return { files, directories, problems };
}

export function limitProblems(files: readonly FileEntry[]): string[] {
  const problems: string[] = [];
  if (files.length > PACK_LIMITS.files) problems.push(`the pack would hold ${files.length} files; the limit is ${PACK_LIMITS.files}`);
  let total = 0;
  for (const file of files) {
    total += file.size;
    if (file.size > PACK_LIMITS.fileBytes) problems.push(`${file.path} is ${file.size} bytes; the limit for one file is ${PACK_LIMITS.fileBytes}`);
    if (Buffer.byteLength(file.path) > PACK_LIMITS.pathBytes) problems.push(`${file.path} is a longer path than ${PACK_LIMITS.pathBytes} bytes`);
    if (/[\u0000-\u001f\u007f]/.test(file.path)) problems.push(`${JSON.stringify(file.path)} has control characters in its name`);
  }
  if (total > PACK_LIMITS.totalBytes) problems.push(`the pack would hold ${total} bytes; the limit is ${PACK_LIMITS.totalBytes}`);
  return problems;
}
