import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWindowPaneDataControl,
  requireWindowPaneDataControl,
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

test("negative control separates absent detection from runtime failure", () => {
  const detected = {
    status: 1,
    signal: null,
    stdout: "",
    stderr:
      "x.c:12:1: runtime error: applying zero offset to null pointer\nSUMMARY: UndefinedBehaviorSanitizer",
  };
  assert.equal(classifyWindowPaneDataControl(detected), "detected");
  // Darwin sanitizer runtimes may abort instead of returning exit status 1.
  assert.equal(
    classifyWindowPaneDataControl({ ...detected, status: null, signal: "SIGABRT" }),
    "detected",
  );
  const silent = {
    status: 0,
    signal: null,
    stdout: "actual window_pane_get_new_data: NULL-empty, zero, partial and end offsets passed\n",
    stderr: "",
  };
  assert.equal(classifyWindowPaneDataControl(silent), "not-detected");
  for (const broken of [
    { ...silent, error: Error("timeout") },
    { ...silent, signal: "SIGKILL" },
    { ...silent, status: null, signal: "SIGABRT" },
    { ...detected, status: null, signal: "SIGKILL" },
    { ...silent, stdout: "" },
    { ...silent, stderr: "warning" },
    { ...detected, status: 2 },
    { ...detected, stderr: "unrelated runtime error" },
    { ...detected, stderr: detected.stderr + "\nruntime error: other bug" },
    { ...detected, stderr: detected.stderr + "\nERROR: AddressSanitizer" },
  ])
    assert.equal(classifyWindowPaneDataControl(broken), "unexpected-failure");
  for (const termination of [
    { status: 1, signal: null },
    { status: null, signal: "SIGABRT" },
  ]) {
    for (const stderr of [
      detected.stderr + "\nAddressSanitizer:DEADLYSIGNAL",
      detected.stderr.replace("null pointer\n", "null pointer with unexpected suffix\n"),
    ])
      assert.equal(
        classifyWindowPaneDataControl({ ...detected, ...termination, stderr }),
        "unexpected-failure",
      );
  }
});
test("original Darwin x64 detector remains mandatory while ARM observation is explicit", () => {
  requireWindowPaneDataControl("detected", "darwin", "x64");
  requireWindowPaneDataControl("not-detected", "darwin", "arm64");
  assert.throws(() => requireWindowPaneDataControl("not-detected", "darwin", "x64"));
  for (const arch of ["arm64", "x64"])
    assert.throws(() => requireWindowPaneDataControl("unexpected-failure", "darwin", arch));
});
