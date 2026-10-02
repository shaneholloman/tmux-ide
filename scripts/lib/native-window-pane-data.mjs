/** Exercise the exact maintained window.c function, not a second implementation. */
export function extractWindowPaneDataFunction(source) {
  const functions = [
    ...source.matchAll(
      /^void \*\nwindow_pane_get_new_data\(struct window_pane \*wp,\n {4}struct window_pane_offset \*wpo, size_t \*size\)\n\{\n[\s\S]*?^\}\n/gm,
    ),
  ];
  if (functions.length !== 1 || functions[0][0].length > 4096)
    throw new Error("Expected one bounded upstream window_pane_get_new_data function");
  return functions[0][0];
}
export function windowPaneDataHarness(source) {
  return `/* Generated from the exact archived/patched window.c. */
#include <assert.h>
#include <stddef.h>
#include <stdio.h>
struct evbuffer { unsigned char *data; size_t length; };
struct bufferevent { struct evbuffer *input; };
struct window_pane { struct bufferevent *event; size_t base_offset; };
struct window_pane_offset { size_t used; };
#define EVBUFFER_LENGTH(buffer) ((buffer)->length)
#define EVBUFFER_DATA(buffer) ((buffer)->data)
${extractWindowPaneDataFunction(source)}
int main(void) {
  struct evbuffer input = { NULL, 0 };
  struct bufferevent event = { &input };
  struct window_pane pane = { &event, 7 };
  struct window_pane_offset offset = { 7 };
  size_t size = 123;
  assert(window_pane_get_new_data(&pane, &offset, &size) == NULL);
  assert(size == 0);
  unsigned char data[] = { 'a', 'b', 'c' };
  input.data = data; input.length = 3;
  assert(window_pane_get_new_data(&pane, &offset, &size) == data);
  assert(size == 3);
  offset.used = 8;
  assert(window_pane_get_new_data(&pane, &offset, &size) == data + 1);
  assert(size == 2);
  offset.used = 10;
  assert(window_pane_get_new_data(&pane, &offset, &size) == data + 3);
  assert(size == 0);
  puts("actual window_pane_get_new_data: NULL-empty, zero, partial and end offsets passed");
  return 0;
}
`;
}

/** Only the original empty-pointer diagnostic is an expected negative control. */
export function classifyWindowPaneDataControl(result) {
  if (result.error || typeof result.stdout !== "string" || typeof result.stderr !== "string")
    return "unexpected-failure";
  if (
    ((result.status === 1 && !result.signal) ||
      (result.status === null && result.signal === "SIGABRT")) &&
    (result.stderr.match(/runtime error:/g) ?? []).length === 1 &&
    /^.*: runtime error: applying zero offset to null pointer\r?$/m.test(result.stderr) &&
    !/AddressSanitizer/.test(result.stderr)
  )
    return "detected";
  if (
    result.status === 0 &&
    !result.signal &&
    result.stderr === "" &&
    result.stdout.trim() ===
      "actual window_pane_get_new_data: NULL-empty, zero, partial and end offsets passed"
  )
    return "not-detected";
  return "unexpected-failure";
}

export function requireWindowPaneDataControl(outcome, platform, arch) {
  if (outcome === "unexpected-failure")
    throw new Error("Unexpected upstream control runtime failure");
  if (platform === "darwin" && arch === "x64" && outcome !== "detected")
    throw new Error("Original Darwin x64 upstream NULL+0 UBSan control did not reproduce");
  if (outcome !== "detected" && outcome !== "not-detected")
    throw new Error("Unknown upstream control outcome");
}
