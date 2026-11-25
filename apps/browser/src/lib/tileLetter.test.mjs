import assert from "node:assert/strict";
import { test } from "node:test";
const { tileLetterOf } = await import("./tileLetter.ts");

test("a pinned tile's letter is its site name's first letter, without subdomains or the suffix", () => {
  assert.equal(tileLetterOf("https://www.figma.com/files", "Figma"), "F");
  assert.equal(tileLetterOf("https://news.ycombinator.com/", "Hacker News"), "Y");
  assert.equal(tileLetterOf("https://mail.google.com/mail/u/0/", "Inbox"), "G");
  assert.equal(tileLetterOf("https://www.bbc.co.uk/news", "BBC"), "B");
  assert.equal(tileLetterOf("https://en.wikipedia.org/wiki/Web_browser", "Web browser"), "W");
  assert.equal(tileLetterOf("https://x.com/home", "Home / X"), "X");
});

test("an address with no letters, or none at all, takes the title's first letter", () => {
  assert.equal(tileLetterOf("http://127.0.0.1:8080/notes", "  — notes"), "N");
  assert.equal(tileLetterOf("", "Écrire"), "É");
  assert.equal(tileLetterOf("", ""), "•");
});

test("custom tile letters keep at most two visible characters, upper-cased, and nothing else", async () => {
  const { cleanTileLetters, tileLettersOf } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("gm"), "GM");
  assert.equal(cleanTileLetters("  x "), "X");
  assert.equal(cleanTileLetters("abc"), "AB");
  assert.equal(cleanTileLetters("é1"), "É1");
  assert.equal(cleanTileLetters("🚀"), "🚀");
  assert.equal(cleanTileLetters("a\nb"), "AB");
  assert.equal(cleanTileLetters(""), null);
  assert.equal(cleanTileLetters("   "), null);
  assert.equal(cleanTileLetters(42), null);
  assert.equal(tileLettersOf({ url: "https://mail.google.com/", title: "Inbox" }), "G");
  assert.equal(tileLettersOf({ url: "https://mail.google.com/", title: "Inbox", tileLetters: "GM" }), "GM");
});

test("tile letters count what you see: a letter that upper-cases to two counts as two, an emoji sequence or an accented letter counts as one, and cleaning twice changes nothing", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("aß"), "AS", "ß upper-cases to SS before the limit");
  assert.equal(cleanTileLetters("👩‍💻"), "👩‍💻", "a ZWJ sequence is one");
  assert.equal(cleanTileLetters("👩‍💻x"), "👩‍💻X");
  assert.equal(cleanTileLetters("👍🏽a"), "👍🏽A", "a skin tone stays with its emoji");
  assert.equal(cleanTileLetters("🇫🇷🇩🇪x"), "🇫🇷🇩🇪", "a flag is one");
  assert.equal(cleanTileLetters("éx"), "ÉX", "a combining accent joins its letter");
  assert.equal(cleanTileLetters("q̣̇z"), "Q̣̇Z".normalize("NFC"));
  assert.equal(cleanTileLetters("́a"), "A", "a mark with nothing before it goes");
  assert.equal(cleanTileLetters("a‮b"), "AB", "a direction override goes");
  const samples = ["aß", "ß", "👩‍💻", "👩‍💻👩‍💻x", "🇫🇷🇩🇪", "é", "ǆ", "ﬃ", "İi", "ŉ", "́́", "a‍", "‍a", "x\u{E0067}"];
  for (const s of samples) {
    const once = cleanTileLetters(s);
    assert.equal(cleanTileLetters(once ?? ""), once, `cleaning ${JSON.stringify(s)} twice`);
  }
});

test("tile letters stay at two graphemes and a bounded length whatever is typed or synced, and cleaning twice changes nothing", async () => {
  const { cleanTileLetters, TILE_LETTERS_MAX_LENGTH } = await import("./tileLetter.ts");
  assert.equal(cleanTileLetters("a‍b‍c"), "AB", "a joiner between letters joins nothing");
  const marked = cleanTileLetters("a" + "́".repeat(4096));
  assert.ok(marked.length <= TILE_LETTERS_MAX_LENGTH, JSON.stringify(marked));
  assert.equal(cleanTileLetters("a ́"), cleanTileLetters(cleanTileLetters("a ́")));
  assert.equal(cleanTileLetters("a ́"), "Á");
  assert.equal(cleanTileLetters("aß"), "AS");
  assert.equal(cleanTileLetters("👩‍💻"), "👩‍💻");
  assert.equal(cleanTileLetters("👨‍👩‍👧‍👦👨‍👩‍👧‍👦x"), "👨‍👩‍👧‍👦👨‍👩‍👧‍👦");
  assert.equal(cleanTileLetters("🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"), "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", "a subdivision flag is one");
  assert.equal(cleanTileLetters("\u{1F3FB}a"), "A", "a skin tone with no emoji goes");
  const samples = ["a‍b‍c", "a" + "́".repeat(4096), "a ́", "aß", "👩‍💻", "x" + "\u{E0067}".repeat(500), "🇫🇷🇩", "ǅx", "ﬀ", "ŉ", "İi", "ậ́̀b"];
  for (const s of samples) {
    const once = cleanTileLetters(s);
    assert.equal(cleanTileLetters(once ?? ""), once, `cleaning ${JSON.stringify(s)} twice`);
    assert.ok(!once || once.length <= TILE_LETTERS_MAX_LENGTH, JSON.stringify(once));
  }
});

test("for ordinary letters, accents, emoji and flags the tile's two graphemes are the ones Intl.Segmenter finds, which Hermes lacks", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const firstTwo = (text) => [...segmenter.segment(text.normalize("NFC").toLocaleUpperCase().normalize("NFC"))].slice(0, 2).map((s) => s.segment).join("");
  for (const text of ["gmail", "éclair", "👩‍💻dev", "👍🏽ok", "🇫🇷🇩🇪", "日本語", "한국어", "ق̈ar", "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}x"]) assert.equal(cleanTileLetters(text), firstTwo(text), text);
});

test("tile letters follow Unicode's grapheme rules: symbols that aren't emoji count one each, an Indic conjunct is one, Hangul syllables and jamo join", async () => {
  const { cleanTileLetters } = await import("./tileLetter.ts");
  const { graphemeClusters } = await import("./graphemes.ts");
  assert.equal(cleanTileLetters("⌀⌀⌀"), "⌀⌀");
  assert.equal(cleanTileLetters("क्षअ"), "क्षअ");
  assert.deepEqual(graphemeClusters("क्षअ"), ["क्ष", "अ"]);
  assert.deepEqual(graphemeClusters("한국"), ["한", "국"]);
  assert.deepEqual(graphemeClusters("한"), ["한"]);
  assert.equal(cleanTileLetters("👩‍👩‍👧x"), "👩‍👩‍👧X");
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const samples = ["⌀⌀⌀", "क्षअ", "ক্ষমা", "ક્ષર", "త్రి", "ക്ഷേ", "한국어", "👩‍💻👨‍👩‍👧", "🇫🇷🇩🇪🇮🇹", "é̂x", "🏳️‍🌈x", "ﷺab", "؀١x", "ไทย", "ລາວ"];
  for (const text of samples) assert.deepEqual(graphemeClusters(text), [...segmenter.segment(text)].map((s) => s.segment), text);
});
