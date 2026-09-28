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
