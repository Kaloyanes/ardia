import assert from "node:assert/strict";
import { test } from "node:test";
const { graphemeClusters } = await import("./graphemes.ts");

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const icu = (text) => Array.from(segmenter.segment(text), (s) => s.segment);
const same = (text) => JSON.stringify(graphemeClusters(text)) === JSON.stringify(icu(text));

test("every code point splits as Intl.Segmenter splits it, after a letter, before a letter, after a virama and after an emoji joiner", () => {
  const drift = [];
  for (let cp = 0; cp <= 0x10ffff && drift.length < 20; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    for (const text of ["a" + c + "a", c + "a", "क्" + c + "a", "😀‍" + c, "😀" + c + "‍😀", "한" + c, "ᄀ" + c, "🇫" + c + "🇷"]) if (!same(text)) drift.push(`${cp.toString(16)} in ${JSON.stringify(text)}`);
  }
  assert.deepEqual(drift, []);
});

test("random mixes of marks, joiners, flags, Hangul, Indic and Khmer conjuncts, emoji and controls split as Intl.Segmenter splits them", () => {
  const pool = [..."aA1 ​‌‍़्ְ́̈ក្រស៊ำำ한각각가각ក្ក\r\n\t🇫🇷🇩🇪😀👍🏽👩💻❤️🏳️⃣⌀©؀ـ॰ক্ষોಕ್ತ൫ൎ܏ꦀ𑨺𑂽𑇂𑤿\u{E0067}\u{E007F}\u{1F3F4}ᳵ꧀ၹ္᮫𖵣각\u2065\u{11A47}\u{113D1}"];
  let seed = 7;
  const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const drift = [];
  for (let i = 0; i < 60000 && drift.length < 10; i++) {
    let text = "";
    for (let n = 1 + Math.floor(next() * 8); n > 0; n--) text += pool[Math.floor(next() * pool.length)];
    if (!same(text)) drift.push(JSON.stringify(text));
  }
  assert.deepEqual(drift, []);
});

test("the reported cases: Khmer and Devanagari conjuncts, a prepend sign, symbols that aren't emoji, and emoji sequences", () => {
  assert.deepEqual(graphemeClusters("ស្ករ"), icu("ស្ករ"));
  assert.equal(graphemeClusters("ស្ករ").length, 2);
  assert.deepEqual(graphemeClusters("क्षअ"), ["क्ष", "अ"]);
  assert.deepEqual(graphemeClusters("\u{11A3A}AA"), icu("\u{11A3A}AA"));
  assert.deepEqual(graphemeClusters("⌀⌀⌀"), ["⌀", "⌀", "⌀"]);
  assert.deepEqual(graphemeClusters("👩‍💻👨‍👩‍👧"), ["👩‍💻", "👨‍👩‍👧"]);
});
