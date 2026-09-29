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
