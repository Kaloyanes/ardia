import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
export const OWNER_SWITCH = "--ardia-bench-owner";
export const OWNED_MARKER = ".webui-bench-owned";
export const OPEN_TIMEOUT_MS = 30000;
export const PS_TIMEOUT_MS = 20000;

export function canonicalPath(path, { caseInsensitive = process.platform === "darwin" } = {}) {
  let existing = resolve(path);
  const rest = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(existing.slice(dirname(existing).length).replace(/^\/+/, ""));
    existing = dirname(existing);
  }
  let real = existing;
  try {
    real = realpathSync(existing);
  } catch {}
  const full = rest.length ? join(real, ...rest) : real;
  return caseInsensitive ? full.toLowerCase() : full;
}

export const isInside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export function protectedRoots(home = homedir()) {
  return [`${home}/Documents`, `${home}/Desktop`, `${home}/Downloads`, `${home}/Library`, `${home}/chromium-build`, `${home}/chromium-build-win`, `${home}/Applications`, "/Applications", "/System", "/Library", "/usr", "/bin", "/sbin", "/private/etc", "/Volumes"];
}

export function assertScratch(dir, { home = homedir() } = {}) {
  const path = resolve(dir);
  const real = canonicalPath(path);
  const homeReal = canonicalPath(home);
  if (real === homeReal || real === "/" || real.split(sep).filter(Boolean).length < 2) throw new Error(`refusing data dir ${path}: not a scratch dir`);
  if (isInside(homeReal, real)) throw new Error(`refusing data dir ${path}: it holds the home folder`);
  for (const root of protectedRoots(home)) {
    const rootReal = canonicalPath(root);
    if (isInside(real, rootReal) || isInside(rootReal, real)) throw new Error(`refusing data dir ${path}: inside or above ${root}`);
  }
  return path;
}

export function assertBuild(app, { home = homedir() } = {}) {
  const path = resolve(app);
  const real = canonicalPath(path);
  for (const root of ["/Applications", `${home}/Applications`]) if (isInside(real, canonicalPath(root))) throw new Error(`refusing ${path}: never an installed app, pass a build`);
  if (!real.endsWith(".app")) throw new Error(`${path} is not an .app bundle`);
  return path;
}

export function hiddenOpenArgs({ app, data, port, owner, env = {}, switches = [], log = null }) {
  const bundle = assertBuild(app);
  const dir = assertScratch(data);
  if (!owner) throw new Error("an owner tag is required");
  const merged = { ...env, ARDIA_BACKGROUND: "1", ARDIA_DATA_DIR: dir, ARDIA_REMOTE_DEBUGGING_PORT: String(port) };
  const envArgs = Object.entries(merged).filter(([, v]) => v != null && v !== "").flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const logArgs = log ? ["--stdout", log, "--stderr", log] : [];
  const appSwitches = [...WEBUI_SWITCHES, `--user-data-dir=${dir}/Chromium`, `--ardia-data-dir=${dir}`, `--remote-debugging-port=${port}`, `${OWNER_SWITCH}=${owner}`, ...switches];
  return ["-g", "-n", ...envArgs, ...logArgs, bundle, "--args", ...appSwitches];
}

export function assertHidden(args) {
  const split = args.indexOf("--args");
  const prefix = split < 0 ? args : args.slice(0, split);
  const envs = prefix.flatMap((a, i) => (prefix[i - 1] === "--env" ? [a] : []));
  const value = (name) => envs.filter((e) => e.startsWith(`${name}=`)).map((e) => e.slice(name.length + 1));
  const problems = [];
  const flags = prefix.filter((a, i) => prefix[i - 1] !== "--env" && prefix[i - 1] !== "--stdout" && prefix[i - 1] !== "--stderr");
  if (!flags.includes("-g")) problems.push("open without -g before --args would bring the app forward");
  if (!flags.includes("-n")) problems.push("open without -n before --args could reuse a running app");
  const background = value("ARDIA_BACKGROUND");
  if (background.length !== 1 || background[0] !== "1") problems.push("exactly one ARDIA_BACKGROUND=1 is required before --args");
  const data = value("ARDIA_DATA_DIR");
  if (data.length !== 1) problems.push("exactly one ARDIA_DATA_DIR is required before --args");
  else
    try {
      assertScratch(data[0]);
    } catch (e) {
      problems.push(e.message);
    }
  if (problems.length) throw new Error(`not a hidden instance: ${problems.join("; ")}`);
  return args;
}

export function makeOwnedRoot(parent) {
  assertScratch(parent);
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(resolve(parent), "run-"));
  const token = randomBytes(12).toString("hex");
  writeFileSync(join(root, OWNED_MARKER), token);
  return { root, token };
}

export function makeOwnedDir(owned, name) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`bad scratch name ${name}`);
  const dir = join(owned.root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, OWNED_MARKER), owned.token);
  return dir;
}

export function isOwnedDir(dir, token) {
  try {
    return readFileSync(join(dir, OWNED_MARKER), "utf8") === token;
  } catch {
    return false;
  }
}

export function removeOwnedDir(dir, token) {
  if (!isOwnedDir(dir, token)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

const LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*\S)\s*$/;
export function parseProcessRows(text) {
  return text.split("\n").map((l) => LINE.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), started: m[3].replace(/\s+/g, " "), command: m[4] }));
}

export function readProcessRows() {
  const r = spawnSync("ps", ["-ww", "-ax", "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ps failed: ${r.error?.code ?? r.stderr}`);
  return parseProcessRows(r.stdout);
}

export function ownedTree(rows, { owner, binaries }) {
  const tagged = rows.filter((r) => r.command.includes(`${OWNER_SWITCH}=${owner}`) && binaries.some((b) => r.command === b || r.command.startsWith(`${b} `)));
  const kids = new Map();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r]);
  const out = [...tagged];
  for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i].pid) ?? []) if (!out.some((o) => o.pid === k.pid)) out.push(k);
  return out;
}

export function sameProcess(a, b) {
  return a.pid === b.pid && a.started === b.started && a.command === b.command;
}

export function processIdentity({ owner, app, binary }) {
  const binaries = [...new Set([binary, canonicalPath(binary, { caseInsensitive: false })].filter(Boolean))];
  return { owner, app, binaries, seen: new Map() };
}

const keyOf = (row) => `${row.pid} ${row.started}`;

export function trackOwned(identity, rows) {
  identity.seen ??= new Map();
  for (const row of ownedTree(rows, identity)) identity.seen.set(keyOf(row), { pid: row.pid, started: row.started, command: row.command });
  const live = new Map(rows.map((r) => [keyOf(r), r]));
  return [...identity.seen.values()].filter((s) => live.has(keyOf(s)));
}

export function parseFootprint(text) {
  const toMb = (value, unit) => Number(value) * (unit === "GB" ? 1024 : unit === "KB" ? 1 / 1024 : unit === "B" ? 1 / 1048576 : 1);
  const totals = [...text.matchAll(/^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s+TOTAL\b/gm)];
  if (totals.length) return Math.round(toMb(totals.at(-1)[1], totals.at(-1)[2]));
  const phys = [...text.matchAll(/phys_footprint:\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/g)];
  return phys.length ? Math.round(phys.reduce((sum, [, v, u]) => sum + toMb(v, u), 0)) : null;
}

export function parseRss(text) {
  return new Map(text.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 2 && r.every(Number.isFinite)));
}

export function memoryOf(identity) {
  const tree = trackOwned(identity, readProcessRows());
  if (!tree.length) return { rssMb: null, footprintMb: null, processes: 0 };
  const pids = tree.map((r) => r.pid);
  const rss = parseRss(execFileSync("ps", ["-o", "pid=,rss=", "-p", pids.join(",")], { encoding: "utf8", timeout: PS_TIMEOUT_MS }));
  const rssKb = pids.reduce((sum, p) => sum + (rss.get(p) ?? 0), 0);
  const fp = spawnSync("footprint", pids.flatMap((p) => ["-p", String(p)]), { encoding: "utf8", timeout: 60000 });
  return { rssMb: Math.round(rssKb / 1024), footprintMb: fp.status === 0 ? parseFootprint(fp.stdout) : null, processes: pids.length };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function signalOwned(identity, signal, read, kill) {
  const alive = trackOwned(identity, read());
  const fresh = new Set(trackOwned(identity, read()).map(keyOf));
  for (const row of alive) if (fresh.has(keyOf(row))) try { kill(row.pid, signal); } catch {}
  return alive.length;
}

const killer = (pid, signal) => process.kill(pid, signal);

export async function stopOwned(identity, { graceMs = 5000, killMs = 3000, read = readProcessRows, kill = killer } = {}) {
  if (!signalOwned(identity, "SIGTERM", read, kill)) return true;
  for (const end = Date.now() + graceMs; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (!trackOwned(identity, read()).length) return true;
  signalOwned(identity, "SIGKILL", read, kill);
  for (const end = Date.now() + killMs; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (!trackOwned(identity, read()).length) return true;
  return false;
}

export function stopOwnedSync(identity, { read = readProcessRows, waitMs = 3000 } = {}) {
  try {
    signalOwned(identity, "SIGKILL", read, killer);
    for (const end = Date.now() + waitMs; Date.now() < end; sleepSync(100)) if (!trackOwned(identity, read()).length) return true;
    return !trackOwned(identity, read()).length;
  } catch {
    return false;
  }
}

export function cleanupRegistry({ keep = false, onSignal = (code) => process.exit(code), stopSync = stopOwnedSync } = {}) {
  const instances = new Map();
  const dirs = new Map();
  const closers = new Set();
  let ran = false;
  const runSync = () => {
    if (ran) return;
    ran = true;
    for (const close of closers) try { close(); } catch {}
    const stuck = [];
    for (const identity of instances.values()) if (!stopSync(identity)) stuck.push(identity.owner);
    if (!keep) for (const [dir, token] of dirs) if (!stuck.length) removeOwnedDir(dir, token);
    if (stuck.length) console.error(`instances still running (${stuck.join(", ")}); scratch dirs kept`);
  };
  const signal = (name, code) => () => {
    console.error(`\n${name}: stopping ${instances.size} instance(s)${keep ? "" : ` and removing ${dirs.size} scratch dir(s)`}`);
    runSync();
    onSignal(code);
  };
  const handlers = { SIGINT: signal("SIGINT", 130), SIGTERM: signal("SIGTERM", 143), SIGHUP: signal("SIGHUP", 129) };
  return {
    instance: (identity) => (instances.set(identity.owner, identity), () => instances.delete(identity.owner)),
    dir: (dir, token) => (dirs.set(dir, token), () => dirs.delete(dir)),
    closer: (fn) => (closers.add(fn), () => closers.delete(fn)),
    runSync,
    install: () => {
      for (const [name, fn] of Object.entries(handlers)) process.on(name, fn);
      process.on("exit", runSync);
    },
    uninstall: () => {
      for (const [name, fn] of Object.entries(handlers)) process.off(name, fn);
      process.off("exit", runSync);
    },
    get size() {
      return { instances: instances.size, dirs: dirs.size, closers: closers.size };
    },
  };
}

let sequence = 0;
export async function fileProbe(data, { cmd, result }, command, timeoutMs = 8000) {
  if ("window" in command && !(Number.isInteger(command.window) && command.window > 0)) throw new Error(`${command.op}: no valid window number (${command.window})`);
  const id = `${process.pid}-${Date.now()}-${++sequence}`;
  const resultPath = join(data, result);
  writeFileSync(join(data, cmd), JSON.stringify({ ...command, id }));
  for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
    if (existsSync(resultPath))
      try {
        const answer = JSON.parse(readFileSync(resultPath, "utf8"));
        if (answer.id === id) {
          if (answer.ok === false) throw Object.assign(new Error(`${command.op}: ${answer.error ?? "failed"}`), { probe: true });
          return answer;
        }
      } catch (e) {
        if (e.probe) throw e;
      }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no answer to ${command.op} from ${cmd} within ${timeoutMs} ms`);
}

export const ACSWIPE = { cmd: "bench-swipe-cmd.json", result: "bench-swipe-result.json" };
export const ACFRAMES = { cmd: "bench-frames-cmd.json", result: "bench-frames-result.json" };
