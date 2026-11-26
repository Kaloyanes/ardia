import { isFields } from "../../lib/decode";
import type { PluginManifest } from "../../lib/pluginManifest";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { notePlugin } from "../telemetry/pluginCounts";
import { requestProfile } from "./channelData";
import { manifestInProfile } from "./profileScope";
import { activeManifest, currentPlugins } from "./store";
import { invokePluginCall } from "./tools";

type Caller = { name: string; run: number };

export const STANDARD_SERVICES = ["ai.provider", "credentials.provider", "search.provider"] as const;
const INTERFACE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const METHOD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_METHODS = 64;
const CALL_TIMEOUT_MS = { least: 1000, most: 120_000, default: 30_000 } as const;

const offered = new Map<string, Map<string, { run: number; methods: string[] }>>();

const ifaceOf = (value: unknown) => (typeof value === "string" && INTERFACE.test(value) ? value : null);

function methodsOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_METHODS || !value.every((m) => typeof m === "string" && METHOD.test(m))) return null;
  return [...new Set(value as string[])];
}

export function provideService(c: Caller, m: PluginManifest, iface: string, methods: string[]): string | null {
  if (!m.provides.includes(iface)) return `${iface} isn't in this plugin's provides.`;
  const table = offered.get(iface) ?? new Map();
  table.set(c.name, { run: c.run, methods });
  offered.set(iface, table);
  return null;
}

export function noteReadyServices(c: Caller, m: PluginManifest, given: unknown) {
  if (!isFields(given)) return;
  for (const [iface, methods] of Object.entries(given)) {
    const checked = methodsOf(methods);
    if (ifaceOf(iface) && checked) provideService(c, m, iface, checked);
  }
}

export function servicesMethod(c: Caller, m: PluginManifest, method: string, params: Record<string, unknown>): Body | Promise<Body> {
  const iface = ifaceOf(params.iface);
  if (!iface) return failure("bad_request", "iface is an interface name like ai.provider.");
  if (method === "services.provide") {
    const methods = methodsOf(params.methods);
    if (!methods) return failure("bad_request", `methods is a list of up to ${MAX_METHODS} method names.`);
    const problem = provideService(c, m, iface, methods);
    return problem ? failure("refused", problem) : { result: { ok: true } };
  }
  if (method === "services.withdraw") {
    const table = offered.get(iface);
    if (table?.get(c.name)?.run === c.run) table.delete(c.name);
    return { result: { ok: true } };
  }
  if (method === "services.list") return listServices(c, m, iface, params);
  return callService(c, m, iface, params);
}

function mayUse(m: PluginManifest, iface: string, provider: PluginManifest): boolean {
  if (provider.name === m.name) return true;
  const depends = Object.hasOwn(m.dependencies, provider.id) || Object.hasOwn(m.optionalDependencies, provider.id);
  return m.consumes.includes(iface) || depends;
}

function providersFor(c: Caller, m: PluginManifest, iface: string, profileId: string | null): PluginManifest[] {
  const s = currentPlugins();
  return s.order.flatMap((name) => {
    const provider = activeManifest(s, name);
    if (!provider || !provider.provides.includes(iface) || !mayUse(m, iface, provider)) return [];
    if (provider.scope === "profile" && profileId !== null && !manifestInProfile(s, name, profileId)) return [];
    if (provider.scope === "profile" && profileId === null && m.scope === "profile") return [];
    return name === c.name && !offered.get(iface)?.has(name) ? [] : [provider];
  });
}

function listServices(c: Caller, m: PluginManifest, iface: string, params: Record<string, unknown>): Body {
  if (!m.consumes.includes(iface) && !Object.keys({ ...m.dependencies, ...m.optionalDependencies }).length) return failure("refused", `Listing ${iface} needs it in this plugin's consumes.`);
  const profile = requestProfile(c.name, m, params);
  const providers = providersFor(c, m, iface, profile.ok ? profile.profileId : null).map((p) => ({ plugin: p.id, version: p.version, methods: offered.get(iface)?.get(p.name)?.methods ?? [] }));
  return { result: { providers } };
}

async function callService(c: Caller, m: PluginManifest, iface: string, params: Record<string, unknown>): Promise<Body> {
  const method = params.method;
  if (typeof method !== "string" || !METHOD.test(method)) return failure("bad_request", "method is a method name.");
  const given = params.timeoutMs;
  if (given !== undefined && (typeof given !== "number" || !Number.isInteger(given) || given < CALL_TIMEOUT_MS.least || given > CALL_TIMEOUT_MS.most))
    return failure("bad_request", `timeoutMs is a whole number from ${CALL_TIMEOUT_MS.least} to ${CALL_TIMEOUT_MS.most}.`);
  const profile = requestProfile(c.name, m, params);
  const profileId = profile.ok ? profile.profileId : null;
  const candidates = providersFor(c, m, iface, profileId);
  const wanted = typeof params.provider === "string" ? candidates.find((p) => p.id === params.provider || p.name === params.provider) : candidates[0];
  if (!wanted) {
    notePlugin("plugin_service_refusals");
    return failure("refused", candidates.length || typeof params.provider !== "string" ? `No plugin this plugin may use provides ${iface}.` : `${String(params.provider)} doesn't provide ${iface} to this plugin.`);
  }
  const known = offered.get(iface)?.get(wanted.name)?.methods;
  if (known && !known.includes(method)) return failure("bad_request", `${wanted.id} has no ${iface} method ${method}.`);
  notePlugin("plugin_service_calls");
  const outcome = await invokePluginCall(wanted.name, { kind: "service", iface, method, input: params.input ?? null }, { kind: "plugin", plugin: c.name }, (given as number | undefined) ?? CALL_TIMEOUT_MS.default, {
    profile: wanted.scope === "profile" ? profileId : null,
  });
  return outcome.ok ? { result: outcome.result } : failure(outcome.code, outcome.message);
}

export function dropServices(name: string) {
  for (const table of offered.values()) table.delete(name);
}

export const offeredServices = (iface: string) => [...(offered.get(iface)?.keys() ?? [])];
