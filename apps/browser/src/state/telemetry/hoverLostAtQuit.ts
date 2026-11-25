import { readDocument, removeDocument, writeDocument } from "../../platform/documents";
import { capture, queueSavedDurably, stillValid, type ConsentToken } from "./client";
import { uuidv7 } from "./ids";
import { context } from "./requestContext";

export const HELD_QUIT_EPISODE_DOC = "hover-lost-at-quit.json";
export const COMMITTED_QUIT_EPISODE_DOC = "hover-lost-at-quit-committed.json";
const EVENT = "page_hover_lost";

type HeldQuitEpisode = { serial: number; uuid: string; at: number; epoch: string; properties: Record<string, unknown>; context: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseHeldRecord(held: unknown): HeldQuitEpisode | null {
  if (!isRecord(held)) return null;
  const { serial, uuid, at, epoch, properties, context: original } = held;
  if (typeof serial !== "number" || typeof uuid !== "string" || typeof at !== "number" || typeof epoch !== "string" || !isRecord(properties) || !isRecord(original)) return null;
  return { serial, uuid, at, epoch, properties, context: original };
}

function readHeld(name: string): HeldQuitEpisode | null {
  try {
    return parseHeldRecord(JSON.parse(readDocument(name) ?? "null"));
  } catch {
    return null;
  }
}

function readCommitted(name: string): HeldQuitEpisode[] {
  try {
    const parsed: unknown = JSON.parse(readDocument(name) ?? "null");
    if (Array.isArray(parsed)) return parsed.map(parseHeldRecord).filter((entry): entry is HeldQuitEpisode => entry !== null);
    const single = parseHeldRecord(parsed);
    return single ? [single] : [];
  } catch {
    return [];
  }
}

function remove(name: string) {
  try {
    removeDocument(name);
  } catch {}
}

export function holdQuitEpisode(serial: unknown, properties: Record<string, unknown>, consent: ConsentToken | null) {
  if (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial <= 0 || !consent || !stillValid(consent)) return;
  const held: HeldQuitEpisode = { serial, uuid: uuidv7(), at: Date.now(), epoch: consent, properties, context: context() };
  try {
    writeDocument(HELD_QUIT_EPISODE_DOC, JSON.stringify(held));
  } catch {}
}

export function retireHeldQuitEpisode(serial: unknown) {
  if (readHeld(HELD_QUIT_EPISODE_DOC)?.serial === serial) remove(HELD_QUIT_EPISODE_DOC);
}

export const dropHeldQuitEpisode = () => remove(HELD_QUIT_EPISODE_DOC);

export function dropQuitEpisodes() {
  remove(HELD_QUIT_EPISODE_DOC);
  remove(COMMITTED_QUIT_EPISODE_DOC);
}

export async function sendCommittedQuitEpisode(): Promise<boolean> {
  remove(HELD_QUIT_EPISODE_DOC);
  const committed = readCommitted(COMMITTED_QUIT_EPISODE_DOC).filter((entry) => stillValid(entry.epoch as ConsentToken));
  if (!committed.length) {
    remove(COMMITTED_QUIT_EPISODE_DOC);
    return false;
  }
  for (const entry of committed) {
    capture(EVENT, entry.properties, entry.epoch as ConsentToken, { raw: entry.context, uuid: entry.uuid, at: entry.at, persist: true });
  }
  const durable = await queueSavedDurably();
  if (durable) remove(COMMITTED_QUIT_EPISODE_DOC);
  return durable;
}
