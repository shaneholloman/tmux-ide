import { expect, it, vi } from "vitest";
const read = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: readonly string[],
      options: { timeoutMs: number; signal: AbortSignal },
    ) => Promise<string>
  >(),
);
vi.mock("./bounded-tmux-read.ts", () => ({ boundedTmuxRead: read }));
vi.mock("./unix-socket-authority.ts", () => ({
  captureUnixSocketIdentity: () => ({ path: "/owned/socket" }),
  revalidateUnixSocketIdentity: () => "/owned/socket",
}));
import { NativeTmuxInteractionObserver } from "./native-tmux-interaction-observer.ts";

const capability = JSON.stringify({
  schemaVersion: 2,
  type: "capability",
  serverEpoch: "a729e244-2531-430c-a947-2dd0a68b0341",
  journalEpoch: "973ab7cb-f8a7-471e-87e8-b40a7da2bf29",
  enabled: false,
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
});

it.each([
  { waitMs: 30, commandMs: 2000, runnerMs: 2000, status: "disabled" },
  { waitMs: 60000, commandMs: 2000, runnerMs: 60000, status: "disabled" },
  { waitMs: 60000, commandMs: 30, runnerMs: 60000, status: "unavailable" },
])(
  "keeps command budget $commandMs independent of legacy lease $waitMs",
  async ({ waitMs, commandMs, runnerMs, status }) => {
    vi.useFakeTimers();
    read.mockReset();
    // Keep the production observer -> fenced runner -> pinned runner path. Only
    // the subprocess boundary is simulated, honoring BOTH its cap and signal.
    read.mockImplementation(
      (_file, _args, options) =>
        new Promise((resolve, reject) => {
          const finish = (error?: Error) => {
            clearTimeout(response);
            clearTimeout(deadline);
            options.signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(capability);
          };
          const abort = () => finish(new Error("request aborted"));
          const response = setTimeout(() => finish(), 50);
          const deadline = setTimeout(
            () => finish(new Error("runner deadline")),
            options.timeoutMs,
          );
          options.signal.addEventListener("abort", abort, { once: true });
        }),
    );
    const observer = new NativeTmuxInteractionObserver({
      tmuxAuthority: {
        executablePath: process.execPath,
        socketSelector: { kind: "path", path: "/owned/socket" },
      },
      nativeServerIdentity: { pid: "123", startTime: "456" },
      enable: false,
      onEvent: () => undefined,
      timing: { waitMs, commandMs },
    });
    try {
      const started = observer.start();
      await vi.advanceTimersByTimeAsync(60);
      expect(await started).toBe(status);
      expect(read).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ timeoutMs: runnerMs }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await observer.dispose();
      vi.useRealTimers();
    }
  },
);
