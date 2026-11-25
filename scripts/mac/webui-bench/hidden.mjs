import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export const WEBUI_SWITCHES = [
  "--ardia-shell=webui",
  "--ardia-background",
  "--use-mock-keychain",
  "--remote-allow-origins=*",
  "--disable-stack-profiler",
  "--disable-backgrounding-occluded-windows",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
];

const forbiddenRoots = () => {
  const home = homedir();
  return [`${home}/Documents`, `${home}/Desktop`, `${home}/Library/Application Support`, `${home}/chromium-build`].map((p) => resolve(p));
};

export function assertScratch(dir) {
  const path = resolve(dir);
  if (path === resolve(homedir()) || path === "/" || path.split(sep).length < 3) throw new Error(`refusing data dir ${path}: not a scratch dir`);
  for (const root of forbiddenRoots()) if (path === root || path.startsWith(root + sep)) throw new Error(`refusing data dir ${path}: inside ${root}`);
  return path;
}

export function assertBuild(app) {
  const path = resolve(app);
  if (/^\/Applications\/[^/]+\.app(\/|$)/.test(path)) throw new Error(`refusing ${path}: never an installed app, pass a build`);
  if (!path.endsWith(".app")) throw new Error(`${path} is not an .app bundle`);
  return path;
}

export function hiddenOpenArgs({ app, data, port, env = {}, switches = [], log = null }) {
  const bundle = assertBuild(app);
  const dir = assertScratch(data);
  const merged = { ...env, ARDIA_BACKGROUND: "1", ARDIA_DATA_DIR: dir, ARDIA_REMOTE_DEBUGGING_PORT: String(port) };
  const envArgs = Object.entries(merged).filter(([, v]) => v != null && v !== "").flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const logArgs = log ? ["--stdout", log, "--stderr", log] : [];
  const appSwitches = [...WEBUI_SWITCHES, `--user-data-dir=${dir}/Chromium`, `--ardia-data-dir=${dir}`, `--remote-debugging-port=${port}`, ...switches];
  return ["-g", "-n", ...envArgs, ...logArgs, bundle, "--args", ...appSwitches];
}

export function assertHidden(args) {
  const at = (flag) => args.indexOf(flag);
  const envs = args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));
  const value = (name) => envs.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1);
  const problems = [];
  if (at("-g") < 0) problems.push("open without -g would bring the app forward");
  if (at("-n") < 0) problems.push("open without -n could reuse a running app");
  if (value("ARDIA_BACKGROUND") !== "1") problems.push("ARDIA_BACKGROUND=1 is missing");
  const data = value("ARDIA_DATA_DIR");
  if (!data) problems.push("ARDIA_DATA_DIR is missing");
  else
    try {
      assertScratch(data);
    } catch (e) {
      problems.push(e.message);
    }
  if (problems.length) throw new Error(`not a hidden instance: ${problems.join("; ")}`);
  return args;
}

export function parsePs(text) {
  return text
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((r) => r.length >= 3 && r.every(Number.isFinite))
    .map(([pid, ppid, rssKb]) => ({ pid, ppid, rssKb }));
}

export function treeOf(rows, root) {
  const kids = new Map();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const pids = [root];
  for (let i = 0; i < pids.length; i++) for (const k of kids.get(pids[i]) ?? []) if (!pids.includes(k)) pids.push(k);
  const live = new Set(rows.map((r) => r.pid));
  const inTree = pids.filter((p) => live.has(p));
  const rssKb = rows.filter((r) => inTree.includes(r.pid)).reduce((sum, r) => sum + r.rssKb, 0);
  return { pids: inTree, rssMb: Math.round(rssKb / 1024) };
}

export function processTree(root) {
  return treeOf(parsePs(execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 20000 })), root);
}

const toMb = (value, unit) => Number(value) * (unit === "GB" ? 1024 : unit === "KB" ? 1 / 1024 : unit === "B" ? 1 / 1048576 : 1);

export function parseFootprint(text) {
  const totals = [...text.matchAll(/^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s+TOTAL\b/gm)];
  if (totals.length) return Math.round(toMb(totals.at(-1)[1], totals.at(-1)[2]));
  const phys = [...text.matchAll(/phys_footprint:\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/g)];
  return phys.length ? Math.round(phys.reduce((sum, [, v, u]) => sum + toMb(v, u), 0)) : null;
}

export function footprintMb(pids) {
  const r = spawnSync("footprint", pids.flatMap((p) => ["-p", String(p)]), { encoding: "utf8", timeout: 60000 });
  return r.status === 0 ? parseFootprint(r.stdout) : null;
}

export function memoryOf(root) {
  const t = processTree(root);
  return { rssMb: t.rssMb, footprintMb: footprintMb(t.pids), processes: t.pids.length };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

export async function stopTree(root, { graceMs = 5000 } = {}) {
  let pids = [];
  try {
    pids = processTree(root).pids;
  } catch {
    pids = [root];
  }
  for (const pid of pids) try { process.kill(pid, "SIGTERM"); } catch {}
  for (const end = Date.now() + graceMs; pids.some(alive) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  for (const pid of pids.filter(alive)) try { process.kill(pid, "SIGKILL"); } catch {}
}

export function stopTreeSync(root) {
  let pids = [root];
  try {
    pids = processTree(root).pids;
  } catch {}
  for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch {}
}

export function cleanupRegistry({ keep = false, onSignal = (code) => process.exit(code) } = {}) {
  const pids = new Set();
  const dirs = new Set();
  const closers = new Set();
  let ran = false;
  const runSync = () => {
    if (ran) return;
    ran = true;
    for (const close of closers) try { close(); } catch {}
    for (const pid of pids) stopTreeSync(pid);
    if (!keep) for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  };
  const signal = (name, code) => () => {
    console.error(`\n${name}: stopping ${pids.size} instance(s)${keep ? "" : ` and removing ${dirs.size} scratch dir(s)`}`);
    runSync();
    onSignal(code);
  };
  const handlers = { SIGINT: signal("SIGINT", 130), SIGTERM: signal("SIGTERM", 143), SIGHUP: signal("SIGHUP", 129) };
  const install = () => {
    for (const [name, fn] of Object.entries(handlers)) process.on(name, fn);
    process.on("exit", runSync);
  };
  const uninstall = () => {
    for (const [name, fn] of Object.entries(handlers)) process.off(name, fn);
    process.off("exit", runSync);
  };
  return {
    pid: (p) => (pids.add(p), () => pids.delete(p)),
    dir: (d) => (dirs.add(assertScratch(d)), d),
    closer: (fn) => (closers.add(fn), () => closers.delete(fn)),
    runSync,
    install,
    uninstall,
    get size() {
      return { pids: pids.size, dirs: dirs.size, closers: closers.size };
    },
  };
}

let sequence = 0;
export async function fileProbe(data, { cmd, result }, command, timeoutMs = 8000) {
  const id = `${process.pid}-${Date.now()}-${++sequence}`;
  const resultPath = `${data}/${result}`;
  writeFileSync(`${data}/${cmd}`, JSON.stringify({ ...command, id }));
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    if (existsSync(resultPath))
      try {
        const answer = JSON.parse(readFileSync(resultPath, "utf8"));
        if (answer.id === id) return answer;
      } catch {}
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no answer to ${command.op} from ${cmd} within ${timeoutMs} ms`);
}

export const ACSWIPE = { cmd: "bench-swipe-cmd.json", result: "bench-swipe-result.json" };
export const ACFRAMES = { cmd: "bench-frames-cmd.json", result: "bench-frames-result.json" };
