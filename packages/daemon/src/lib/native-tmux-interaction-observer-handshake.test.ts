import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeJournalCursor } from "@tmux-ide/contracts";

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  start: vi.fn(),
  read: vi.fn(),
  dispose: vi.fn(),
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
    start = mocks.start;
    read = mocks.read;
    dispose = mocks.dispose;
  },
}));
import { NativeTmuxInteractionObserver } from "./native-tmux-interaction-observer.ts";

const serverEpoch = "11111111-1111-4111-8111-111111111111";
const journalEpoch = "22222222-2222-4222-8222-222222222222";
function pending(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
function batch(cursor: NativeJournalCursor): string {
  const sequence = String(BigInt(cursor.sequence) + 1n);
  return JSON.stringify({
    schemaVersion: 2,
    type: "batch",
    serverEpoch,
    journalEpoch,
    oldest: "1",
    newest: sequence,
    gap: null,
    next: sequence,
    degraded: 0,
    records: [
      {
        sequence,
        commandId: sequence,
        issuerId: "1",
        monotonicUs: "1",
        count: "0",
        targetBirthId: "1",
        targetId: 0,
        kind: 1,
        outcome: 1,
        flags: 1,
        requestId: sequence,
        parentCommandId: "0",
        transport: 1,
        derivation: 0,
        correlation: null,
      },
    ],
  });
}
function observer() {
  return new NativeTmuxInteractionObserver({
    tmuxAuthority: {
      executablePath: "/test/tmux",
      socketSelector: { kind: "path", path: "/test/socket" },
    },
    nativeServerIdentity: { pid: "1", startTime: "1" },
    timing: { commandMs: 10, waitMs: 1000, retryMs: 1, maxRetryMs: 1 },
    onEvent: () => {},
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.start.mockResolvedValue(undefined);
  mocks.dispose.mockResolvedValue(undefined);
  mocks.read.mockImplementation((_cursor: NativeJournalCursor, signal: AbortSignal) =>
    pending(signal),
  );
  mocks.run.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 2,
      type: "capability",
      serverEpoch,
      journalEpoch,
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
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("hundreds of completed batches leave no idle lease or handshake deadline", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  let remaining = 300;
  mocks.read.mockImplementation((cursor: NativeJournalCursor, signal: AbortSignal) =>
    remaining-- > 0 ? Promise.resolve(batch(cursor)) : pending(signal),
  );
  const reader = observer();
  try {
    await reader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.read).toHaveBeenCalledTimes(301);
    expect(mocks.construct).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(125_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledTimes(301);
    expect(mocks.construct).toHaveBeenCalledTimes(1);
  } finally {
    await reader.dispose();
    timeout.mockRestore();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("a stalled handshake expires independently of the read lease and retires its peer", async () => {
  let handshake: AbortSignal | undefined;
  mocks.start.mockImplementation((signal: AbortSignal) => {
    handshake = signal;
    return pending(signal);
  });
  const reader = observer();
  try {
    await reader.start();
    await vi.advanceTimersByTimeAsync(9);
    expect(handshake?.aborted).toBe(false);
    expect(mocks.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(handshake?.aborted).toBe(true);
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
  } finally {
    await reader.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("a replacement peer gets its own bounded handshake after a read failure", async () => {
  let replacementHandshake: AbortSignal | undefined;
  mocks.start.mockResolvedValueOnce(undefined).mockImplementation((signal: AbortSignal) => {
    replacementHandshake = signal;
    return pending(signal);
  });
  mocks.read.mockRejectedValueOnce(new Error("peer disconnected"));
  const reader = observer();
  try {
    await reader.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.construct).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(replacementHandshake?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(replacementHandshake?.aborted).toBe(true);
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
  } finally {
    await reader.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});
