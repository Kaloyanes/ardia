import { displayHostOf } from "./url";

const LETTER = /\p{L}/u;

const firstLetter = (text: string): string | null => {
  for (const char of text) if (LETTER.test(char)) return char.toLocaleUpperCase();
  return null;
};

const SECOND_LEVEL = /^(?:co|com|net|org|gov|edu|ac|ne|or|go)$/;

function siteName(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host;
  const suffix = labels.length > 2 && SECOND_LEVEL.test(labels[labels.length - 2]!) ? 2 : 1;
  return labels[labels.length - 1 - suffix] ?? host;
}

export function tileLetterOf(url: string, title: string): string {
  const host = url ? siteName(displayHostOf(url)) : "";
  const fromHost = host && LETTER.test([...host][0] ?? "") ? firstLetter(host) : null;
  return fromHost ?? firstLetter(title) ?? "•";
}

export const TILE_LETTERS_MAX = 2;

const UNSEEN = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\s]|(?![\u200D\u{E0020}-\u{E007F}])\p{Cf}/gu;
const EXTENDS = /[\p{M}\u200D\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;
const REGIONAL = /[\u{1F1E6}-\u{1F1FF}]/u;
const ZWJ = "\u200D";

function graphemes(text: string): string[] {
  const out: string[] = [];
  let joinNext = false;
  for (const char of text) {
    const last = out[out.length - 1];
    const pairsFlag = last !== undefined && REGIONAL.test(char) && [...last].length === 1 && REGIONAL.test(last);
    if (last !== undefined && (joinNext || EXTENDS.test(char) || pairsFlag)) out[out.length - 1] = last + char;
    else if (!EXTENDS.test(char)) out.push(char);
    joinNext = char === ZWJ;
  }
  return out;
}

export function cleanTileLetters(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const shown = input.normalize("NFC").toLocaleUpperCase().normalize("NFC").replace(UNSEEN, "");
  const kept = graphemes(shown).slice(0, TILE_LETTERS_MAX).join("");
  return kept || null;
}

export const tileLettersOf = (t: { url: string; title: string; customTitle?: string | null; tileLetters?: string | null }): string =>
  t.tileLetters || tileLetterOf(t.url, t.customTitle ?? t.title);
