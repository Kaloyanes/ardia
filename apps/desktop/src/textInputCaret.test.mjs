import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { TextInput } = await import("./shims/react-native.tsx");
const render = (props) => renderToStaticMarkup(createElement(TextInput, { value: "", onChangeText: () => {}, ...props }));

test(`a field's cursorColor becomes its caret colour in the ${process.env.ARDIA_DESKTOP_MODE ?? "linux"} WebUI`, () => {
  const html = render({ cursorColor: "#787D86", style: { color: "#000000" } });
  assert.match(html, /caret-color:\s*(#787D86|rgba?\(120,\s*125,\s*134)/i, html);
  assert.match(html, /color:\s*(#000000|rgba?\(0,\s*0,\s*0)/i, "the field's own style is kept");
});

test("caretHidden still hides the caret when a cursorColor is set, and no cursorColor leaves the caret alone", () => {
  const hidden = render({ cursorColor: "#787D86", caretHidden: true });
  assert.match(hidden, /r-caretColor-/, `React Native Web's transparent caret class is kept: ${hidden}`);
  assert.doesNotMatch(hidden, /caret-color:/i, `no inline caret colour overrides it: ${hidden}`);
  assert.doesNotMatch(render({}), /caret-color/i);
  assert.doesNotMatch(render({ cursorColor: "#787D86" }), /cursorcolor/i, "the prop doesn't reach the DOM as an attribute");
});
