export const PAGE_READ_LIMITS = { text: 200_000, markdown: 200_000, selection: 20_000, headings: 100, links: 200, forms: 20, fields: 40 } as const;

export type PageReadFlags = { markdown: boolean; metadata: boolean; selection: boolean };

export function pageReadScript(flags: PageReadFlags): string {
  const L = PAGE_READ_LIMITS;
  return `(() => {
  const flags = ${JSON.stringify(flags)};
  const clip = (text, max) => String(text || "").replace(/\\s+/g, " ").trim().slice(0, max);
  const meta = (name) => { const node = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]'); return node ? clip(node.getAttribute("content"), 1000) : ""; };
  const root = document.querySelector("article") || document.querySelector("main") || document.body;
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "ASIDE", "FORM", "SVG", "IFRAME", "TEMPLATE", "BUTTON"]);
  const out = [];
  let size = 0;
  const push = (line) => { if (size < ${L.markdown}) { out.push(line); size += line.length + 1; } };
  const inline = (node) => {
    let text = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.textContent;
      else if (child.nodeType === 1 && !skip.has(child.tagName)) {
        const tag = child.tagName;
        const inner = inline(child);
        if (tag === "A" && child.href && /^https?:/.test(child.href)) text += "[" + inner.trim() + "](" + child.href + ")";
        else if (tag === "STRONG" || tag === "B") text += "**" + inner + "**";
        else if (tag === "EM" || tag === "I") text += "_" + inner + "_";
        else if (tag === "CODE") text += "\`" + inner + "\`";
        else if (tag === "BR") text += "\\n";
        else text += inner;
      }
    }
    return text;
  };
  const walk = (node) => {
    for (const child of node.children) {
      if (skip.has(child.tagName) || child.hidden || child.getAttribute("aria-hidden") === "true") continue;
      const tag = child.tagName;
      if (/^H[1-6]$/.test(tag)) push("#".repeat(Number(tag[1])) + " " + clip(child.innerText, 300));
      else if (tag === "P" || tag === "BLOCKQUOTE") { const text = inline(child).replace(/\\s+/g, " ").trim(); if (text) push((tag === "BLOCKQUOTE" ? "> " : "") + text); }
      else if (tag === "PRE") push("\`\`\`\\n" + String(child.innerText).slice(0, 20000) + "\\n\`\`\`");
      else if (tag === "LI") push("- " + inline(child).replace(/\\s+/g, " ").trim());
      else if (tag === "IMG" && child.alt) push("![" + clip(child.alt, 200) + "](" + child.src + ")");
      else if (tag === "TABLE") push(String(child.innerText).split("\\n").map((row) => "| " + row.split("\\t").join(" | ") + " |").join("\\n").slice(0, 20000));
      else walk(child);
    }
  };
  const result = { text: (document.body ? document.body.innerText : "").slice(0, ${L.text}), lang: document.documentElement.lang || "" };
  if (flags.markdown && root) { walk(root); result.markdown = out.join("\\n\\n").slice(0, ${L.markdown}); }
  if (flags.selection) result.selection = String(window.getSelection ? window.getSelection() : "").slice(0, ${L.selection});
  if (flags.metadata) {
    const canonical = document.querySelector('link[rel="canonical"]');
    result.metadata = {
      description: meta("og:description") || meta("description"),
      siteName: meta("og:site_name"),
      author: meta("author") || meta("article:author"),
      publishedAt: meta("article:published_time"),
      image: meta("og:image"),
      lang: result.lang,
      canonicalUrl: canonical && /^https?:/.test(canonical.href) ? canonical.href : "",
    };
    result.headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].slice(0, ${L.headings}).map((h) => ({ level: Number(h.tagName[1]), text: clip(h.innerText, 300) }));
    result.links = [...document.querySelectorAll("a[href]")].filter((a) => /^https?:/.test(a.href)).slice(0, ${L.links}).map((a) => ({ text: clip(a.innerText, 200), url: a.href }));
    result.forms = [...document.forms].slice(0, ${L.forms}).map((f) => ({
      fields: [...f.elements].filter((e) => e.name || e.id).slice(0, ${L.fields}).map((e) => ({ name: clip(e.name || e.id, 100), type: clip(e.type || e.tagName.toLowerCase(), 30), label: clip((e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute("aria-label") || e.placeholder || "", 200) })),
    }));
  }
  post("result", JSON.stringify(result));
})()`;
}
