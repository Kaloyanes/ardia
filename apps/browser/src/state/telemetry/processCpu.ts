import type { EngineTask } from "../../platform/performance";

const percentOfCore = (percent: number) => Math.round(Math.min(percent, 10_000) * 10) / 10;

export function processCpuFields(tasks: readonly Pick<EngineTask, "type" | "cpu">[]) {
  const cpu = { browser: 0, gpu: 0, renderers: 0, rendererMax: 0, other: 0 };
  for (const t of tasks) {
    const used = Number.isFinite(t.cpu) ? Math.max(0, t.cpu) : 0;
    if (t.type === "browser") cpu.browser += used;
    else if (t.type === "gpu") cpu.gpu += used;
    else if (t.type === "renderer") (cpu.renderers += used), (cpu.rendererMax = Math.max(cpu.rendererMax, used));
    else cpu.other += used;
  }
  return {
    browser_cpu_pct: percentOfCore(cpu.browser),
    gpu_cpu_pct: percentOfCore(cpu.gpu),
    renderer_cpu_pct: percentOfCore(cpu.renderers),
    renderer_cpu_max_pct: percentOfCore(cpu.rendererMax),
    helper_cpu_pct: percentOfCore(cpu.other),
  };
}
