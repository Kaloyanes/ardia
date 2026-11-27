import type { RemoteOutcome } from "./omnibox.ts";

export type RemoteAnswer = { text: string; values: string[] };

export type RemoteFetch = (text: string, signal: AbortSignal) => Promise<RemoteOutcome>;

export type RemoteAsk = { scope: string; text: string; remembers: boolean; current: () => string | null; show: (answer: RemoteAnswer, cached: boolean) => void };

export const MOST_REMOTE_IN_FLIGHT = 3;

export const REMOTE_ANSWERS_KEPT = 64;

export function carriedValues(answer: RemoteAnswer | null, text: string): string[] {
  if (!answer?.text || !text.startsWith(answer.text)) return [];
  if (answer.text === text) return answer.values;
  const typed = text.trim().toLowerCase();
  return answer.values.filter((value) => value.toLowerCase().startsWith(typed));
}

type Flight = { scope: string; text: string; controller: AbortController };

export function createRemoteSuggester(fetchRemote: RemoteFetch) {
  const answers = new Map<string, string[]>();
  let flights: Flight[] = [];
  let asked = 0;
  let shownTicket = 0;
  let shown: { scope: string; answer: RemoteAnswer } | null = null;

  const answerKey = (scope: string, text: string) => `${scope}\u0000${text}`;

  const remember = (key: string, values: string[]) => {
    answers.delete(key);
    answers.set(key, values);
    if (answers.size > REMOTE_ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
  };

  const land = (ticket: number, ask: RemoteAsk, values: string[], cached: boolean) => {
    const now = ask.current();
    if (now === null || !now.startsWith(ask.text) || ticket < shownTicket) return;
    shownTicket = ticket;
    shown = { scope: ask.scope, answer: { text: ask.text, values } };
    ask.show(shown.answer, cached);
  };

  const ground = (keep: (flight: Flight) => boolean) => {
    const kept: Flight[] = [];
    for (const flight of flights) {
      if (keep(flight)) kept.push(flight);
      else flight.controller.abort();
    }
    flights = kept;
  };

  return {
    shown(scope: string): RemoteAnswer | null {
      return shown?.scope === scope ? shown.answer : null;
    },
    forget(drop: (value: string) => boolean) {
      if (shown) shown = { scope: shown.scope, answer: { text: shown.answer.text, values: shown.answer.values.filter((value) => !drop(value)) } };
      for (const [key, values] of answers) answers.set(key, values.filter((value) => !drop(value)));
    },
    reset() {
      ground(() => false);
      shown = null;
      shownTicket = ++asked;
    },
    inFlight: () => flights.length,
    ask(ask: RemoteAsk) {
      const ticket = ++asked;
      const key = answerKey(ask.scope, ask.text);
      const known = answers.get(key);
      if (known) {
        land(ticket, ask, known, true);
        return;
      }
      ground((flight) => flight.scope === ask.scope && ask.text.startsWith(flight.text));
      while (flights.length >= MOST_REMOTE_IN_FLIGHT) flights.shift()!.controller.abort();
      const flight: Flight = { scope: ask.scope, text: ask.text, controller: new AbortController() };
      flights.push(flight);
      void fetchRemote(ask.text, flight.controller.signal).then((outcome) => {
        flights = flights.filter((other) => other !== flight);
        if (flight.controller.signal.aborted || outcome.status !== "ok") return;
        if (ask.remembers) remember(key, outcome.values);
        land(ticket, ask, outcome.values, false);
      });
    },
  };
}
