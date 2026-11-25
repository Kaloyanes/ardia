type Break = "CR" | "LF" | "Control" | "Extend" | "ZWJ" | "RI" | "Prepend" | "SpacingMark" | "L" | "V" | "T" | "LV" | "LVT" | "Other";

const GRAPHEME_EXTEND = /\p{Grapheme_Extend}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const SPACING = /\p{Mc}/u;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}]|(?![\u200C\u200D\u{E0020}-\u{E007F}])\p{Cf}/u;
const ZWJ = 0x200d;

const PREPEND = new Set([0x06dd, 0x070f, 0x0890, 0x0891, 0x08e2, 0x0d4e, 0x110bd, 0x110cd, 0x111c2, 0x111c3, 0x1193f, 0x11941, 0x11a3a, 0x11d46, 0x11f02]);
const isPrepend = (cp: number) => PREPEND.has(cp) || (cp >= 0x0600 && cp <= 0x0605) || (cp >= 0x11a84 && cp <= 0x11a89);
const NOT_SPACING = new Set([0x102b, 0x102c, 0x1038, 0x1062, 0x1063, 0x1064, 0x1067, 0x1068, 0x1069, 0x106a, 0x106b, 0x106c, 0x106d, 0x1083, 0x1087, 0x1088, 0x1089, 0x108a, 0x108b, 0x108c, 0x108f, 0x109a, 0x109b, 0x109c, 0x1a61, 0x1a63, 0x1a64, 0xaa7b, 0xaa7d, 0x11720, 0x11721]);

const LINKERS = new Set([0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d]);
const CONSONANTS: [number, number][] = [
  [0x0915, 0x0939], [0x0958, 0x095f], [0x0978, 0x097f],
  [0x0995, 0x09a8], [0x09aa, 0x09b0], [0x09b2, 0x09b2], [0x09b6, 0x09b9], [0x09dc, 0x09dd], [0x09df, 0x09df], [0x09f0, 0x09f1],
  [0x0a95, 0x0aa8], [0x0aaa, 0x0ab0], [0x0ab2, 0x0ab3], [0x0ab5, 0x0ab9], [0x0af9, 0x0af9],
  [0x0b15, 0x0b28], [0x0b2a, 0x0b30], [0x0b32, 0x0b33], [0x0b35, 0x0b39], [0x0b5c, 0x0b5d], [0x0b5f, 0x0b5f], [0x0b71, 0x0b71],
  [0x0c15, 0x0c28], [0x0c2a, 0x0c39], [0x0c58, 0x0c5a],
  [0x0d15, 0x0d3a],
];
const isConsonant = (cp: number) => CONSONANTS.some(([from, to]) => cp >= from && cp <= to);

function breakOf(char: string, cp: number): Break {
  if (cp === 0x0d) return "CR";
  if (cp === 0x0a) return "LF";
  if (cp === ZWJ) return "ZWJ";
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return "RI";
  if (isPrepend(cp)) return "Prepend";
  if (GRAPHEME_EXTEND.test(char) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) return "Extend";
  if (CONTROL.test(char)) return "Control";
  if ((SPACING.test(char) && !NOT_SPACING.has(cp)) || cp === 0x0e33 || cp === 0x0eb3) return "SpacingMark";
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)) return "L";
  if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)) return "V";
  if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) return "T";
  if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return "Other";
}

type Run = { prev: Break | null; regional: number; pictographic: 0 | 1 | 2; conjunct: 0 | 1 | 2 };

function joins(run: Run, now: Break, cp: number): boolean {
  const { prev } = run;
  if (prev === null) return false;
  if (prev === "CR" && now === "LF") return true;
  if (prev === "CR" || prev === "LF" || prev === "Control" || now === "CR" || now === "LF" || now === "Control") return false;
  if (prev === "L" && (now === "L" || now === "V" || now === "LV" || now === "LVT")) return true;
  if ((prev === "LV" || prev === "V") && (now === "V" || now === "T")) return true;
  if ((prev === "LVT" || prev === "T") && now === "T") return true;
  if (now === "Extend" || now === "ZWJ" || now === "SpacingMark" || prev === "Prepend") return true;
  if (run.conjunct === 2 && isConsonant(cp)) return true;
  if (prev === "ZWJ" && run.pictographic === 2 && PICTOGRAPHIC.test(String.fromCodePoint(cp))) return true;
  return prev === "RI" && now === "RI" && run.regional % 2 === 1;
}

function advance(run: Run, now: Break, char: string, cp: number) {
  run.regional = now === "RI" ? run.regional + 1 : 0;
  if (PICTOGRAPHIC.test(char)) run.pictographic = 1;
  else if (run.pictographic && now === "Extend") run.pictographic = 1;
  else run.pictographic = run.pictographic === 1 && now === "ZWJ" ? 2 : 0;
  if (isConsonant(cp)) run.conjunct = 1;
  else if (run.conjunct && LINKERS.has(cp)) run.conjunct = 2;
  else if (!(run.conjunct && (now === "Extend" || now === "ZWJ"))) run.conjunct = 0;
  run.prev = now;
}

export function graphemeClusters(text: string): string[] {
  const out: string[] = [];
  const run: Run = { prev: null, regional: 0, pictographic: 0, conjunct: 0 };
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const now = breakOf(char, cp);
    if (joins(run, now, cp)) out[out.length - 1] += char;
    else out.push(char);
    advance(run, now, char, cp);
  }
  return out;
}

export const startsCluster = (cluster: string): boolean => {
  const cp = cluster.codePointAt(0)!;
  const kind = breakOf(String.fromCodePoint(cp), cp);
  return kind !== "Extend" && kind !== "ZWJ" && kind !== "SpacingMark";
};

export const isPictographic = (char: string): boolean => PICTOGRAPHIC.test(char);
