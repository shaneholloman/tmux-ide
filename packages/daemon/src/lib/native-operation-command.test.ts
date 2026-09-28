import { describe, expect, it } from "vitest";
import { nativeOperationWrapperArgs } from "./native-operation-command.ts";
const id = "00000000-0000-4000-8000-000000000001";
describe("strict native operation command serialization", () => {
  it("keeps a literal semicolon separate from command boundaries", () => {
    expect(
      nativeOperationWrapperArgs(id, [
        ["send-keys", "-t", "%1", "-l", "--", ";"],
        ["send-keys", "-t", "%1", "Enter"],
      ]),
    ).toEqual([
      "tmux-ide-run",
      "-I",
      "-O",
      id,
      "'send-keys' '-t' '%1' '-l' '--' ';' ; 'send-keys' '-t' '%1' 'Enter'",
    ]);
  });
  it("rejects NUL, invalid identities and oversized bodies before dispatch", () => {
    expect(() => nativeOperationWrapperArgs(id, [["send-keys", "a\0b"]])).toThrow();
    expect(() => nativeOperationWrapperArgs("not-an-id", [["capture-pane"]])).toThrow();
    expect(() => nativeOperationWrapperArgs(id, [])).toThrow();
    expect(() => nativeOperationWrapperArgs(id, [["send-keys", "'".repeat(70_000)]])).toThrow();
  });
});
it("carries a validated expected epoch into the native wrapper before its body", () => {
  expect(nativeOperationWrapperArgs(id, [["capture-pane", "-p"]], id).slice(0, 6)).toEqual([
    "tmux-ide-run",
    "-I",
    "-E",
    id,
    "-O",
    id,
  ]);
  expect(() => nativeOperationWrapperArgs(id, [["capture-pane"]], "invalid")).toThrow();
});

it("requires epoch and bounded physical identity for a guarded pane", () => {
  const pane = { paneId: "%0", paneBirthId: "18446744073709551615" };
  expect(nativeOperationWrapperArgs(id, [["capture-pane", "-p"]], id, pane).slice(4, 8)).toEqual([
    "-t",
    "%0",
    "-B",
    pane.paneBirthId,
  ]);
  expect(() => nativeOperationWrapperArgs(id, [["capture-pane"]], undefined, pane)).toThrow();
  for (const paneId of ["%01", "%4294967296", "%x", "session"]) {
    expect(() =>
      nativeOperationWrapperArgs(id, [["capture-pane"]], id, { ...pane, paneId }),
    ).toThrow();
  }
  for (const paneBirthId of ["0", "01", "18446744073709551616"]) {
    expect(() =>
      nativeOperationWrapperArgs(id, [["capture-pane"]], id, { ...pane, paneBirthId }),
    ).toThrow();
  }
});
it("accepts the existing 256-byte input chunk while keeping an explicit argv bound", () => {
  const command = ["send-keys", "-t", "%0", "-H", ...Array<string>(256).fill("ff")];
  expect(() => nativeOperationWrapperArgs(id, [command], id)).not.toThrow();
  expect(() =>
    nativeOperationWrapperArgs(id, [["send-keys", ...Array<string>(512).fill("ff")]], id),
  ).toThrow();
});
