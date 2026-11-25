#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HELP = `Parity gate: reads a shootout's bench.json and judges the WebUI against React Native.

  node scripts/mac/webui-bench/gate.mjs <bench.json> [--baseline <older bench.json>] [--rules <rules.json>]
      [--regression 10] [--allow-missing] [--markdown <out.md>] [--json]

Each rule reads one metric's median (or p95) on both sides. The WebUI passes a rule when its value is at most
RN x ratio + tolerance, or at most the rule's budget (a value that is fine whatever RN does), and never above the
rule's cap. Rules with no RN side (vsRn false) only check budget and cap. With --baseline, a WebUI value more than
--regression percent (default 10) above the baseline's WebUI value is a regression and fails. A metric missing on a
side the rule needs fails, unless --allow-missing makes it a skip. Prints a Markdown table; exits 0 on PASS, 1 on FAIL,
64 on bad input.`;

export const RULES = [
  { key: "launch.large", label: "Cold launch, open → first window (ms)", vsRn: true, tolerance: 150, cap: 1500 },
  { key: "memory.small.footprintMb", label: "Memory 3 × 1 tab, phys_footprint (MB)", vsRn: true },
  { key: "memory.small.rssMb", label: "Memory 3 × 1 tab, RSS (MB)", vsRn: true },
  { key: "memory.large.footprintMb", label: "Memory 150 + 15 + 5 tabs, phys_footprint (MB)", vsRn: true },
  { key: "memory.large.rssMb", label: "Memory 150 + 15 + 5 tabs, RSS (MB)", vsRn: true },
  { key: "memory.multi.footprintMb", label: "Memory 2 windows + peek, phys_footprint (MB)", vsRn: true },
  { key: "memory.multi.rssMb", label: "Memory 2 windows + peek, RSS (MB)", vsRn: true },
  { key: "swipe.fwd.p95GapMs", label: "Swipe Personal → Work, frame gap p95 (ms)", vsRn: true },
  { key: "swipe.back.p95GapMs", label: "Swipe Work → Personal, frame gap p95 (ms)", vsRn: true },
  { key: "swipe.fwd.restMs", label: "Swipe Personal → Work, motion → rest (ms)", vsRn: true, tolerance: 100, budget: 500 },
  { key: "swipe.back.restMs", label: "Swipe Work → Personal, motion → rest (ms)", vsRn: true, tolerance: 100, budget: 500 },
  { key: "swipe.back.rowsPaintedMs", label: "Deep selected row arrival after rest (ms)", vsRn: true, budget: 16 },
  { key: "swipe.blocked.maxGapMs", label: "Swipe with a 500 ms UI-thread block, max gap (ms)", vsRn: false, cap: 150 },
  { key: "swipe.blankFrames", label: "Blank sidebar frames during swipes", vsRn: false, cap: 0, stat: "max" },
  { key: "launch.newTabFrames", label: "Lingering New Tab polls after first window", vsRn: false, cap: 0, stat: "max" },
  { key: "scroll.p95GapMs", label: "Sidebar scroll, 150 tabs, frame gap p95 (ms)", vsRn: true, tolerance: 4 },
  { key: "scroll.maxGapMs", label: "Sidebar scroll, 150 tabs, frame gap max (ms)", vsRn: true, tolerance: 17 },
  { key: "typing.p95Ms", label: "Command bar keystroke → frame p95 (ms)", vsRn: true, tolerance: 8, cap: 100 },
  { key: "typing.missed", label: "Keystrokes with no frame within 250 ms", vsRn: false, cap: 0, stat: "max" },
];

const fmt = (v) => (v == null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1));

export function valueOf(report, side, key, stat = "median") {
  const entry = report?.summary?.[side]?.[key];
  if (entry == null) return null;
  if (typeof entry === "number") return entry;
  const v = entry[stat];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function limitFor(rule, rn) {
  const parts = [];
  if (rule.vsRn && rn != null) parts.push(rn * (rule.ratio ?? 1) + (rule.tolerance ?? 0));
  if (rule.budget != null) parts.push(rule.budget);
  let limit = parts.length ? Math.max(...parts) : null;
  if (rule.cap != null) limit = limit == null ? rule.cap : Math.min(limit, rule.cap);
  return limit;
}

export function judge(rule, report, { baseline = null, regressionPct = 10, allowMissing = false } = {}) {
  const stat = rule.stat ?? "median";
  const rn = valueOf(report, "rn", rule.key, stat);
  const webui = valueOf(report, "webui", rule.key, stat);
  const before = baseline ? valueOf(baseline, "webui", rule.key, stat) : null;
  const limit = limitFor(rule, rn);
  const row = { key: rule.key, label: rule.label, stat, rn, webui, limit, baseline: before, verdict: "PASS", why: "" };
  const missing = webui == null ? "WebUI value missing" : rule.vsRn && rn == null && rule.budget == null && rule.cap == null ? "RN value missing" : null;
  if (missing) return { ...row, verdict: allowMissing ? "SKIP" : "FAIL", why: missing };
  if (limit != null && webui > limit) return { ...row, verdict: "FAIL", why: `${fmt(webui)} > ${fmt(limit)}` };
  if (before != null && webui > before * (1 + regressionPct / 100) && webui - before > 0.5)
    return { ...row, verdict: "REGRESSION", why: `+${fmt(((webui - before) / Math.max(before, 1e-9)) * 100)} % vs baseline ${fmt(before)}` };
  return row;
}

export function evaluate(report, options = {}) {
  const rules = options.rules ?? RULES;
  const rows = rules.map((rule) => judge(rule, report, options));
  const failed = rows.filter((r) => r.verdict === "FAIL" || r.verdict === "REGRESSION");
  return { pass: failed.length === 0, verdict: failed.length ? "FAIL" : "PASS", failed: failed.length, skipped: rows.filter((r) => r.verdict === "SKIP").length, rows };
}

const cell = (s) => String(s).replace(/\|/g, "\\|");

export function markdown(result, { title = "Mac WebUI parity gate", meta = null } = {}) {
  const hasBaseline = result.rows.some((r) => r.baseline != null);
  const head = ["Metric", "RN", "WebUI", "Limit", ...(hasBaseline ? ["Baseline"] : []), "Verdict"];
  const icon = { PASS: "✅ PASS", FAIL: "❌ FAIL", REGRESSION: "📉 REGRESSION", SKIP: "⏭ SKIP" };
  const lines = [
    `## ${title}: ${result.pass ? "✅ PASS" : "❌ FAIL"}`,
    "",
    ...(meta ? [meta, ""] : []),
    `| ${head.join(" | ")} |`,
    `| ${head.map((h, i) => (i === 0 || h === "Verdict" ? "---" : "---:")).join(" | ")} |`,
    ...result.rows.map((r) => {
      const label = r.stat === "median" ? r.label : `${r.label} [${r.stat}]`;
      const verdict = r.why ? `${icon[r.verdict]} (${r.why})` : icon[r.verdict];
      return `| ${[label, fmt(r.rn), fmt(r.webui), fmt(r.limit), ...(hasBaseline ? [fmt(r.baseline)] : []), verdict].map(cell).join(" | ")} |`;
    }),
    "",
    `${result.rows.length - result.failed - result.skipped} passed, ${result.failed} failed, ${result.skipped} skipped.`,
  ];
  return lines.join("\n") + "\n";
}

export function parseGateArgs(argv) {
  const out = { report: null, baseline: null, rules: null, regressionPct: 10, allowMissing: false, markdownOut: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--baseline") out.baseline = take();
    else if (a === "--rules") out.rules = take();
    else if (a === "--regression") {
      out.regressionPct = Number(take());
      if (!Number.isFinite(out.regressionPct) || out.regressionPct < 0) throw new Error("--regression is a percentage ≥ 0");
    } else if (a === "--allow-missing") out.allowMissing = true;
    else if (a === "--markdown") out.markdownOut = take();
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (!out.report) out.report = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let args;
  try {
    args = parseGateArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`gate: ${e.message}\n\n${HELP}`);
    process.exit(64);
  }
  if (args.help || !args.report) {
    console.log(HELP);
    process.exit(args.help ? 0 : 64);
  }
  let report, baseline, rules;
  try {
    report = JSON.parse(readFileSync(args.report, "utf8"));
    baseline = args.baseline ? JSON.parse(readFileSync(args.baseline, "utf8")) : null;
    rules = args.rules ? JSON.parse(readFileSync(args.rules, "utf8")) : RULES;
  } catch (e) {
    console.error(`gate: ${e.message}`);
    process.exit(64);
  }
  if (!report.summary?.rn && !report.summary?.webui) {
    console.error(`gate: ${args.report} has no summary.rn or summary.webui`);
    process.exit(64);
  }
  const result = evaluate(report, { rules, baseline, regressionPct: args.regressionPct, allowMissing: args.allowMissing });
  const meta = report.meta ? `${report.meta.host ?? "?"}, ${report.meta.reps ?? "?"} reps (${report.meta.order ?? "?"}), ${report.meta.finishedAt ?? report.meta.startedAt ?? ""}` : null;
  const md = markdown(result, { meta });
  if (args.markdownOut) writeFileSync(args.markdownOut, md);
  console.log(args.json ? JSON.stringify(result, null, 1) : md);
  process.exit(result.pass ? 0 : 1);
}
