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
export const TILE_LETTERS_MAX_LENGTH = 24;

const MAX_MARKS = 2;
const UNSEEN = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\s]|(?![\u200D\u{E0020}-\u{E007F}])\p{Cf}/gu;
const MARK = /\p{M}/u;
const ZWJ = "\u200D";
const isModifier = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isTag = (cp: number) => cp >= 0xe0020 && cp <= 0xe007f;
const isRegional = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const isPictographic = (cp: number) =>
  (cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2300 && cp <= 0x23ff) || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0x2b00 && cp <= 0x2bff) || [0xa9, 0xae, 0x203c, 0x2049, 0x2122, 0x2139, 0x3030, 0x303d, 0x3297, 0x3299].includes(cp);

function graphemes(text: string): string[] {
  const chars = [...text];
  const out: string[] = [];
  let base = 0;
  let marks = 0;
  let openFlag = false;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    const cp = char.codePointAt(0)!;
    const at = out.length - 1;
    if (MARK.test(char)) {
      if (at >= 0 && marks < MAX_MARKS) (out[at] += char), marks++;
      continue;
    }
    if (isModifier(cp) || isTag(cp)) {
      if (at >= 0 && isPictographic(base)) out[at] += char;
      continue;
    }
    if (char === ZWJ) {
      const next = chars[i + 1]?.codePointAt(0) ?? 0;
      if (at >= 0 && isPictographic(base) && isPictographic(next)) {
        out[at] += char + chars[++i]!;
        base = next;
        marks = 0;
      }
      continue;
    }
    if (openFlag && isRegional(cp)) {
      out[at] += char;
      openFlag = false;
      continue;
    }
    out.push(char);
    base = cp;
    marks = 0;
    openFlag = isRegional(cp);
  }
  return out;
}

function cleanOnce(text: string): string {
  const shown = text.replace(UNSEEN, "").normalize("NFC").toLocaleUpperCase().normalize("NFC").replace(UNSEEN, "");
  let kept = "";
  for (const cluster of graphemes(shown).slice(0, TILE_LETTERS_MAX)) {
    if (kept.length + cluster.length > TILE_LETTERS_MAX_LENGTH) break;
    kept += cluster;
  }
  return kept;
}

export function cleanTileLetters(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let kept = cleanOnce(input.slice(0, TILE_LETTERS_MAX_LENGTH * 8));
  for (let pass = 0; pass < 4; pass++) {
    const again = cleanOnce(kept);
    if (again === kept) break;
    kept = again;
  }
  return kept || null;
}

export const tileLettersOf = (t: { url: string; title: string; customTitle?: string | null; tileLetters?: string | null }): string =>
  t.tileLetters || tileLetterOf(t.url, t.customTitle ?? t.title);
