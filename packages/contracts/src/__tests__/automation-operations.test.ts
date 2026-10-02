import { describe, expect, it } from "vitest";
import {
  AutomationExecuteRequestSchemaZ,
  AutomationOperationStatusSchemaZ,
  AutomationReserveRequestSchemaZ,
} from "../automation-operations.ts";

const id = "00000000-0000-4000-8000-000000000001";
const target = {
  kind: "pane",
  environmentId: id,
  serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: id },
  paneLifetimeId: id,
  workspaceName: "workspace.project",
  semanticPaneId: "pane.editor",
};
const request = {
  version: 1,
  intent: { kind: "send", target, source: null, text: "hello", enter: true },
};

describe("automation boundary", () => {
  it("requires resolved lifetime and explicit source absence", () => {
    expect(AutomationReserveRequestSchemaZ.safeParse(request).success).toBe(true);
    for (const changed of [
      { ...request.intent, target: { ...target, paneLifetimeId: undefined } },
      { ...request.intent, source: undefined },
      { ...request.intent, target: { ...target, runtimePaneId: "%0" } },
      { ...request.intent, origin: "tui" },
      { ...request.intent, credential: "secret" },
    ])
      expect(
        AutomationReserveRequestSchemaZ.safeParse({ ...request, intent: changed }).success,
      ).toBe(false);
  });

  it("bounds UTF-8 bytes and excludes NUL rather than counting only JS characters", () => {
    const parse = (text: string) =>
      AutomationReserveRequestSchemaZ.safeParse({ ...request, intent: { ...request.intent, text } })
        .success;
    expect(parse("a".repeat(16384))).toBe(true);
    expect(parse("a".repeat(16385))).toBe(false);
    expect(parse("🙂".repeat(4096))).toBe(true);
    expect(parse("🙂".repeat(4097))).toBe(false);
    expect(parse("a\0b")).toBe(false);
  });

  it("requires a generation-fenced execution handle", () => {
    expect(AutomationExecuteRequestSchemaZ.safeParse(request).success).toBe(false);
    expect(
      AutomationExecuteRequestSchemaZ.safeParse({
        ...request,
        handle: { generation: id, operationId: id },
      }).success,
    ).toBe(true);
    expect(
      AutomationExecuteRequestSchemaZ.safeParse({ ...request, handle: { operationId: id } })
        .success,
    ).toBe(false);
  });

  it("never admits sent or captured content to operation status", () => {
    expect(
      AutomationOperationStatusSchemaZ.safeParse({
        status: "completed",
        result: { kind: "read", capturedBytes: 12, returnedBytes: 12, truncated: false },
      }).success,
    ).toBe(true);
    for (const key of ["text", "content", "snapshot", "credential"]) {
      expect(
        AutomationOperationStatusSchemaZ.safeParse({
          status: "completed",
          result: { kind: "send", submitted: true, [key]: "private" },
        }).success,
      ).toBe(false);
    }
  });
});
