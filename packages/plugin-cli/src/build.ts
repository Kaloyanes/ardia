import { context, build as esbuild, type BuildOptions, type BuildResult, type Message } from "esbuild";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, type Output } from "./output";
import { entrySources, type Project } from "./project";

export type BuildReport = { ok: boolean; outputs: { entry: string; source: string; bytes: number }[]; errors: string[]; warnings: string[] };

export type BuildFlags = { minify?: boolean; sourcemap?: boolean };

const SDK = "@ardia/plugin-sdk";

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["import", "default"]) if (typeof record[key] === "string") return record[key] as string;
  }
  return null;
}

function bundledSdkAliases(): Record<string, string> {
  let pkgPath: string;
  try {
    pkgPath = createRequire(fileURLToPath(import.meta.url)).resolve(`${SDK}/package.json`);
  } catch {
    return {};
  }
  const root = dirname(pkgPath);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: Record<string, unknown> };
  const aliases: Record<string, string> = {};
  for (const [subpath, value] of Object.entries(pkg.exports ?? {})) {
    const target = exportTarget(value);
    if (!target || subpath.endsWith("package.json")) continue;
    aliases[subpath === "." ? SDK : `${SDK}${subpath.slice(1)}`] = resolve(root, target);
  }
  return aliases;
}

function projectHasSdk(dir: string): boolean {
  try {
    createRequire(join(dir, "package.json")).resolve(`${SDK}/package.json`);
    return true;
  } catch {
    return false;
  }
}

export function buildOptions(project: Project, output: string, source: string, flags: BuildFlags = {}): BuildOptions {
  return {
    entryPoints: [join(project.dir, source)],
    outfile: join(project.dir, output),
    bundle: true,
    format: "iife",
    platform: "neutral",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: SDK,
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    charset: "utf8",
    legalComments: "none",
    minify: flags.minify === true,
    sourcemap: flags.sourcemap === true ? "linked" : false,
    write: false,
    logLevel: "silent",
    absWorkingDir: project.dir,
    alias: projectHasSdk(project.dir) ? {} : bundledSdkAliases(),
  };
}

const REGION_COMMENT = /^[ \t]*\/\/ \S.*\.(?:[cm]?[jt]sx?|json|css)$/gm;

export function cleanBundle(text: string, keepColumns: boolean): string {
  const lines = text.replace(REGION_COMMENT, "");
  return keepColumns ? lines : lines.replace(/\/\* @__PURE__ \*\/ /g, "");
}

function writeOutputs(result: BuildResult, keepColumns: boolean) {
  for (const file of result.outputFiles ?? []) {
    mkdirSync(dirname(file.path), { recursive: true });
    const content = file.path.endsWith(".js") || file.path.endsWith(".mjs") || file.path.endsWith(".cjs") ? cleanBundle(file.text, keepColumns) : file.text;
    writeFileSync(file.path, content);
  }
}

const messageText = (m: Message) => (m.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ${m.text}` : m.text);

type Built = { entry: string; source: string; bytes: number; errors: string[]; warnings: string[] };

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function builtOf(project: Project, entry: string, source: string, result: BuildResult | null, failure?: { errors?: Message[]; warnings?: Message[] }): Built {
  return {
    entry,
    source,
    bytes: result && !result.errors.length ? sizeOf(join(project.dir, entry)) : 0,
    errors: (failure?.errors ?? result?.errors ?? []).map(messageText),
    warnings: (failure?.warnings ?? result?.warnings ?? []).map(messageText),
  };
}

const combine = (built: readonly Built[]): BuildReport => ({
  ok: built.every((b) => b.errors.length === 0),
  outputs: built.map(({ entry, source, bytes }) => ({ entry, source, bytes })),
  errors: built.flatMap((b) => b.errors),
  warnings: built.flatMap((b) => b.warnings),
});

async function buildOne(project: Project, entry: string, source: string, flags: BuildFlags): Promise<Built> {
  try {
    const result = await esbuild(buildOptions(project, entry, source, flags));
    if (!result.errors.length) writeOutputs(result, flags.sourcemap === true);
    return builtOf(project, entry, source, result);
  } catch (error) {
    return builtOf(project, entry, source, null, error as { errors?: Message[]; warnings?: Message[] });
  }
}

export async function buildProject(project: Project, flags: BuildFlags = {}): Promise<BuildReport> {
  const entries = [...entrySources(project)];
  return combine(await Promise.all(entries.map(([entry, source]) => buildOne(project, entry, source, flags))));
}

export async function watchProject(project: Project, flags: BuildFlags, onBuild: (report: BuildReport) => void): Promise<{ dispose(): Promise<void> }> {
  const entries = [...entrySources(project)];
  const latest = new Map<string, Built>();
  const contexts = await Promise.all(
    entries.map(([entry, source]) =>
      context({
        ...buildOptions(project, entry, source, flags),
        plugins: [
          {
            name: "ardia-plugin-report",
            setup(build) {
              build.onEnd((result) => {
                if (!result.errors.length) writeOutputs(result, flags.sourcemap === true);
                latest.set(entry, builtOf(project, entry, source, result));
                if (latest.size === entries.length) onBuild(combine([...latest.values()]));
              });
            },
          },
        ],
      }),
    ),
  );
  if (!entries.length) onBuild(combine([]));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  return { dispose: async () => void (await Promise.all(contexts.map((ctx) => ctx.dispose()))) };
}

export async function runBuild(project: Project, out: Output, flags: BuildFlags = {}): Promise<BuildReport> {
  const report = await buildProject(project, flags);
  for (const warning of report.warnings) out.warn(warning);
  if (!report.ok) throw new CliError("The build failed", report.errors);
  const lines = report.outputs.length ? report.outputs.map((o) => `built ${o.entry} from ${o.source} (${o.bytes} bytes)`) : ["nothing to build: plugin.json names no dist/ entries with sources in src/"];
  out.result(lines.join("\n"), report);
  return report;
}
