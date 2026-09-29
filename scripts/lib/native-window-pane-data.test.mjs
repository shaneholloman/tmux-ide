import assert from "node:assert/strict";
import test from "node:test";
import {
  extractWindowPaneDataFunction,
  windowPaneDataHarness,
} from "./native-window-pane-data.mjs";
const functionText =
  "void *\nwindow_pane_get_new_data(struct window_pane *wp,\n    struct window_pane_offset *wpo, size_t *size)\n{\n\treturn (ACTUAL_SOURCE_SENTINEL);\n}\n";
test("harness embeds the exact extracted production function without rewriting its body", () => {
  assert.equal(
    extractWindowPaneDataFunction("/* upstream */\n" + functionText + "/* next */"),
    functionText,
  );
  const harness = windowPaneDataHarness(functionText);
  assert(harness.includes(functionText));
  assert.equal(harness.split("ACTUAL_SOURCE_SENTINEL").length, 2);
  assert(harness.includes("input = { NULL, 0 }"));
});
test("upstream shape changes or duplicate definitions fail closed", () => {
  for (const text of [
    "",
    functionText + functionText,
    functionText.replace("window_pane *wp", "pane *wp"),
    functionText.replace("ACTUAL_SOURCE_SENTINEL", "x".repeat(5000)),
  ])
    assert.throws(() => extractWindowPaneDataFunction(text));
});
