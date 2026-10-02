import { beforeEach, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn(async () => ""));
vi.mock("./bounded-tmux-read.ts", () => ({ boundedTmuxRead: run }));
vi.mock("./unix-socket-authority.ts", () => ({
  captureUnixSocketIdentity: () => ({ path: "/owned/socket" }),
  revalidateUnixSocketIdentity: () => "/owned/socket",
}));
import { createServerGenerationFencedTmuxAsyncRunner } from "./tmux-server-generation-runner.ts";
const authority = {
  executablePath: process.execPath,
  socketSelector: { kind: "path" as const, path: "/owned/socket" },
};
const identity = { pid: "123", startTime: "456" };
beforeEach(() => run.mockClear());
it("retains five second default while forwarding an explicit bounded journal lease", async () => {
  await createServerGenerationFencedTmuxAsyncRunner(
    authority,
    identity,
  )(["display-message", "-p", ""]);
  expect(run).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.any(Array),
    expect.objectContaining({ timeoutMs: 5000 }),
  );
  await createServerGenerationFencedTmuxAsyncRunner(authority, identity, { timeoutMs: 60000 })([
    "display-message",
    "-p",
    "",
  ]);
  expect(run).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.any(Array),
    expect.objectContaining({ timeoutMs: 60000 }),
  );
});
it("rejects invalid and unbounded timeout overrides before launching", () => {
  for (const timeoutMs of [0, -1, Infinity, 300001])
    expect(() =>
      createServerGenerationFencedTmuxAsyncRunner(authority, identity, { timeoutMs }),
    ).toThrow("timeout");
  expect(run).not.toHaveBeenCalled();
});
