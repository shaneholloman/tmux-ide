import { describe, expect, it } from "vitest";
import { SessionRuntimePaneReadResultSchemaZ } from "../session-runtime.ts";
const snapshot = {
  verb: "workspace.pane.read",
  operationId: "11111111-1111-4111-8111-111111111111",
  daemonInstanceId: "22222222-2222-4222-8222-222222222222",
  workspaceName: "work",
  semanticPaneId: "pane.one",
  format: "ansi",
  availability: "available",
  text: "🙂",
  byteCount: 4,
  capturedByteCount: 4,
  truncated: false,
};
describe("bounded private pane read response", () => {
  it("counts UTF8 bytes rather than UTF16 characters", () => {
    expect(SessionRuntimePaneReadResultSchemaZ.parse(snapshot).byteCount).toBe(4);
    expect(() =>
      SessionRuntimePaneReadResultSchemaZ.parse({ ...snapshot, byteCount: 2 }),
    ).toThrow();
  });
  it("rejects above-cap content and dishonest truncation metadata", () => {
    expect(() =>
      SessionRuntimePaneReadResultSchemaZ.parse({
        ...snapshot,
        text: "🙂".repeat(5000),
        byteCount: 20000,
        capturedByteCount: 20000,
      }),
    ).toThrow();
    expect(() =>
      SessionRuntimePaneReadResultSchemaZ.parse({
        ...snapshot,
        capturedByteCount: 8,
        truncated: false,
      }),
    ).toThrow();
  });
  it("allows content-free replay metadata and forbids replay content", () => {
    expect(
      SessionRuntimePaneReadResultSchemaZ.parse({
        ...snapshot,
        availability: "replay-unavailable",
        text: null,
      }),
    ).toMatchObject({ byteCount: 4, text: null });
    expect(() =>
      SessionRuntimePaneReadResultSchemaZ.parse({
        ...snapshot,
        availability: "replay-unavailable",
      }),
    ).toThrow();
  });
});
