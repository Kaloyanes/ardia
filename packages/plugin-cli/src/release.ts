import { spawnSync } from "node:child_process";
import { PLATFORM_KEYS, type PlatformKey } from "@ardia/plugin-sdk/manifest";
import { parseSemver } from "@ardia/plugin-sdk/semver";
import { runBuild, type BuildFlags } from "./build";
import { CliError, type Output } from "./output";
import { packProject, parsePlatform, type PackReport } from "./pack";
import { loadProject, type Project } from "./project";

export type ReleaseFlags = BuildFlags & { tag?: string; prerelease?: boolean; dryRun?: boolean; platform?: string; repo?: string; notes?: string; draft?: boolean };

export type ReleaseReport = { id: string; version: string; tag: string; repo: string | null; prerelease: boolean; dryRun: boolean; assets: PackReport[]; commands: string[][] };

export type Runner = (command: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: Runner = (command, args) => {
  const run = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (run.error) return { status: null, stdout: "", stderr: run.error.message };
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
};

export const shellQuote = (arg: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

export function releasePlatforms(project: Project, flag: string | undefined): PlatformKey[] {
  if (flag) return flag.split(",").map((p) => parsePlatform(p.trim()));
  const declared = Object.keys(project.manifest.release?.assets ?? {}).filter((p): p is PlatformKey => (PLATFORM_KEYS as readonly string[]).includes(p));
  return declared.length ? declared : ["universal"];
}

export function releaseTag(project: Project, flag: string | undefined): string {
  if (flag) return flag;
  return `${project.manifest.release?.tagPrefix ?? "v"}${project.manifest.version}`;
}

export function releaseCommands(project: Project, tag: string, files: readonly string[], options: { prerelease: boolean; repo: string | null; notes?: string; draft?: boolean; exists: boolean }): string[][] {
  const repo = options.repo ? ["--repo", options.repo] : [];
  if (options.exists) return [["gh", "release", "upload", tag, ...files, "--clobber", ...repo]];
  return [
    [
      "gh",
      "release",
      "create",
      tag,
      ...files,
      "--title",
      `${project.manifest.name} ${project.manifest.version}`,
      ...(options.notes ? ["--notes", options.notes] : ["--generate-notes"]),
      ...(options.prerelease ? ["--prerelease"] : []),
      ...(options.draft ? ["--draft"] : []),
      ...repo,
    ],
  ];
}

export async function runRelease(dir: string | undefined, out: Output, flags: ReleaseFlags = {}, runner: Runner = defaultRunner): Promise<ReleaseReport> {
  const project = loadProject(dir);
  const tag = releaseTag(project, flags.tag);
  const expected = `${project.manifest.release?.tagPrefix ?? "v"}${project.manifest.version}`;
  if (flags.tag && flags.tag !== expected && !flags.tag.endsWith(project.manifest.version)) {
    throw new CliError(`The tag ${flags.tag} doesn't name plugin.json's version ${project.manifest.version}; bump the version or tag ${expected}`);
  }
  const prerelease = flags.prerelease === true || (parseSemver(project.manifest.version)?.prerelease.length ?? 0) > 0;
  const repo = flags.repo ?? project.manifest.release?.github ?? null;
  if (repo && /^OWNER\//.test(repo)) {
    if (!flags.dryRun) throw new CliError(`plugin.json's release.github is still ${repo}; set it to your repository`);
    out.warn(`plugin.json's release.github is still ${repo}; set it to your repository before a real release`);
  }
  await runBuild(project, { ...out, result: () => undefined }, flags);
  const assets: PackReport[] = [];
  for (const platform of releasePlatforms(project, flags.platform)) assets.push(await packProject(project, out, { ...flags, platform, skipBuild: true }));
  const files = [...new Set(assets.flatMap((a) => [a.file, `${a.file}.sha256`]))];
  let exists = false;
  if (!flags.dryRun) {
    const version = runner("gh", ["--version"]);
    if (version.status !== 0) throw new CliError("ardia-plugin release needs the GitHub CLI (gh), signed in: https://cli.github.com");
    exists = runner("gh", ["release", "view", tag, ...(repo ? ["--repo", repo] : [])]).status === 0;
  }
  const commands = releaseCommands(project, tag, files, { prerelease, repo, notes: flags.notes, draft: flags.draft, exists });
  if (flags.dryRun) {
    out.result(
      [`dry run: would release ${project.manifest.id}@${project.manifest.version} as ${tag}${prerelease ? " (prerelease)" : ""}`, ...commands.map((c) => `  ${c.map(shellQuote).join(" ")}`)].join("\n"),
      { id: project.manifest.id, version: project.manifest.version, tag, repo, prerelease, dryRun: true, assets, commands },
    );
    return { id: project.manifest.id, version: project.manifest.version, tag, repo, prerelease, dryRun: true, assets, commands };
  }
  for (const command of commands) {
    out.info(`$ ${command.map(shellQuote).join(" ")}`);
    const run = runner(command[0]!, command.slice(1));
    if (run.status !== 0) throw new CliError(`${command.slice(0, 3).join(" ")} failed`, [run.stderr.trim() || `exit ${run.status}`]);
  }
  const report = { id: project.manifest.id, version: project.manifest.version, tag, repo, prerelease, dryRun: false, assets, commands };
  out.result(`released ${project.manifest.id}@${project.manifest.version} as ${tag}${repo ? ` on ${repo}` : ""} with ${assets.length} asset${assets.length === 1 ? "" : "s"}`, report);
  return report;
}
