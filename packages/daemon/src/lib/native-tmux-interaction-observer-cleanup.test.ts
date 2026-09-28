import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  dispose: vi.fn(async () => {
    throw new Error("unreaped peer");
  }),
  run: vi.fn(),
}));
vi.mock("./tmux-server-generation-runner.ts", () => ({
  createServerGenerationFencedTmuxAsyncRunner: () => mocks.run,
}));
vi.mock("./native-journal-control-connection.ts", () => ({
  NativeJournalControlConnection: class {
    constructor() {
      mocks.construct();
    }
    async start() {}
    read(_cursor: unknown, signal: AbortSignal) {
      return new Promise<string>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    dispose = mocks.dispose;
  },
}));
import { NativeTmuxInteractionObserver } from "./native-tmux-interaction-observer.ts";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("an expired idle lease cannot respawn after its owned peer fails to reap", async () => {
  vi.useFakeTimers();
  mocks.run.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 2,
      type: "capability",
      serverEpoch: "11111111-1111-4111-8111-111111111111",
      journalEpoch: "22222222-2222-4222-8222-222222222222",
      enabled: true,
      coverage: [
        "command-outcome-v1",
        "pty-enqueue-v1",
        "capture-produced-v1",
        "cooperative-operation-v1",
        "pane-identity-v1",
      ],
      capacity: 4096,
      maxBatch: 256,
      maxWaiters: 4,
      waitingReaders: 0,
      degraded: 0,
      readerTransport: "sessionless-control-v1",
    }),
  );
  const states: string[] = [];
  const observer = new NativeTmuxInteractionObserver({
    tmuxAuthority: {
      executablePath: "/test/tmux",
      socketSelector: { kind: "path", path: "/test/socket" },
    },
    nativeServerIdentity: { pid: "1", startTime: "1" },
    timing: { waitMs: 10, commandMs: 10, retryMs: 1, maxRetryMs: 1 },
    onEvent: (event) => {
      if (event.type === "state") states.push(event.status);
    },
  });
  await observer.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(states).toContain("degraded");
  expect(states).not.toContain("retrying");
  expect(mocks.construct).toHaveBeenCalledTimes(1);
  expect(mocks.run).toHaveBeenCalledTimes(1);
  await expect(observer.dispose()).rejects.toThrow("unreaped peer");
  expect(mocks.construct).toHaveBeenCalledTimes(1);
});
