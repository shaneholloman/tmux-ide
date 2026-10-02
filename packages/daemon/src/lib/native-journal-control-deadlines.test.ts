import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeTmuxInteractionObserver } from "./native-tmux-interaction-observer.ts";
import { NativeJournalControlConnection } from "./native-journal-control-connection.ts";

const mocked = vi.hoisted(() => ({ spawn: vi.fn(), run: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
vi.mock("./tmux-server-generation-runner.ts", () => ({
  createServerGenerationFencedTmuxAsyncRunner: () => mocked.run,
}));
const epoch = "00000000-0000-4000-8000-000000000001";
const cursor = { serverEpoch: epoch, journalEpoch: epoch, sequence: "0" };
const capability = {
  schemaVersion: 2,
  type: "capability",
  serverEpoch: epoch,
  journalEpoch: epoch,
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
};
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
function fixture(replyMs = 100) {
  const child = new EventEmitter();
  const stdout = new PassThrough(),
    stderr = new PassThrough(),
    stdin = new EventEmitter();
  const writes: string[] = [];
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      child.emit("close", 0, null);
    }
  };
  Object.assign(stdin, {
    write(text: string) {
      writes.push(text);
      if (text === "\n") close();
      return true;
    },
  });
  Object.assign(child, { stdout, stderr, stdin, kill: vi.fn(close) });
  mocked.spawn.mockImplementation(() => {
    queueMicrotask(() =>
      stdout.write(
        `%begin 1 1 0\n${JSON.stringify(capability)}\n${JSON.stringify({ schemaVersion: 2, type: "identity", serverEpoch: epoch, connectionId: "8" })}\n%end 1 1 0\n`,
      ),
    );
    return child;
  });
  const connection = new NativeJournalControlConnection(
    { executablePath: "/mock/native", socketSelector: { kind: "path", path: "/mock/socket" } },
    epoch,
    replyMs,
  );
  const begin = () => stdout.write("%begin 2 2 1\n");
  return {
    connection,
    child,
    writes,
    begin,
    send: (text: string) => stdout.write(text),
    closed: () => closed,
  };
}

describe("native parked reader phase deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked.spawn.mockReset();
    mocked.run.mockResolvedValue(JSON.stringify(capability));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([16, 32] as const)(
    "a %ims window preserves parked lifetime and the original partial-payload deadline",
    async (observationBatchMs) => {
      const f = fixture(5000);
      const reader = new NativeTmuxInteractionObserver({
        tmuxAuthority: {
          executablePath: "/mock/native",
          socketSelector: { kind: "path", path: "/mock/socket" },
        },
        nativeServerIdentity: { pid: "1", startTime: "1" },
        timing: { commandMs: 5000, retryMs: 60_000, maxRetryMs: 60_000, observationBatchMs },
        onEvent: () => {},
      });
      try {
        await reader.start();
        await flush();
        f.begin();
        const batch = {
          schemaVersion: 2,
          type: "batch",
          serverEpoch: epoch,
          journalEpoch: epoch,
          oldest: "1",
          newest: "1",
          next: "1",
          degraded: 0,
          gap: null,
          records: [
            {
              sequence: "1",
              commandId: "0",
              issuerId: "0",
              monotonicUs: "1",
              count: "0",
              targetId: 0,
              targetBirthId: "1",
              kind: 1,
              outcome: 1,
              flags: 1,
              requestId: "0",
              parentCommandId: "0",
              transport: 0,
              derivation: 0,
              correlation: null,
            },
          ],
        };
        f.send(`${JSON.stringify(batch)}\n%end 2 2 1\n`);
        await flush();
        expect(reader.cursor?.sequence).toBe("1");
        const writes = f.writes.length;
        await vi.advanceTimersByTimeAsync(observationBatchMs - 1);
        expect(f.writes).toHaveLength(writes);
        await vi.advanceTimersByTimeAsync(1);
        expect(f.writes).toHaveLength(writes + 1);
        f.begin();
        await vi.advanceTimersByTimeAsync(125_000);
        expect(reader.status).toBe("ready");
        expect(f.closed()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        f.send("{");
        await vi.advanceTimersByTimeAsync(4999);
        expect(f.closed()).toBe(false);
        f.send('"schemaVersion":');
        await vi.advanceTimersByTimeAsync(1);
        expect(f.closed()).toBe(true);
        expect(mocked.spawn).toHaveBeenCalledTimes(1);
      } finally {
        await reader.dispose();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["one-chunk", "separate-begin"])(
    "does not allocate a payload watchdog for a complete %s reply",
    async (mode) => {
      const f = fixture(5000);
      try {
        await f.connection.start(new AbortController().signal);
        const timer = vi.spyOn(globalThis, "setTimeout");
        const result = f.connection.read(cursor, new AbortController().signal);
        await flush();
        expect(timer).toHaveBeenCalledTimes(1); // Begin watchdog remains mandatory.
        if (mode === "separate-begin") f.begin();
        f.send(`${mode === "one-chunk" ? "%begin 2 2 1\n" : ""}{}\n%end 2 2 1\n`);
        expect(await result).toBe("{}");
        expect(timer).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await f.connection.dispose();
      }
    },
  );

  it("keeps one watchdog across partial chunks and clears it on completion", async () => {
    const f = fixture(5000);
    try {
      await f.connection.start(new AbortController().signal);
      const timer = vi.spyOn(globalThis, "setTimeout");
      const result = f.connection.read(cursor, new AbortController().signal);
      await flush();
      f.begin();
      f.send("{");
      expect(timer).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      f.send("}");
      expect(timer).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      f.send("\n%end 2 2 1\n");
      expect(await result).toBe("{}");
      expect(timer).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.connection.dispose();
    }
  });

  it("cancellation retires an incomplete reply and clears its watchdog", async () => {
    const f = fixture(5000);
    try {
      await f.connection.start(new AbortController().signal);
      const cancellation = new AbortController();
      const result = f.connection.read(cursor, cancellation.signal).catch((error) => error);
      await flush();
      f.begin();
      f.send("{");
      expect(vi.getTimerCount()).toBe(1);
      cancellation.abort();
      expect(await result).toMatchObject({ message: "Native journal request cancelled" });
      expect(f.closed()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.connection.dispose();
    }
  });

  it("deducts synchronous parsing time from an incomplete reply's original deadline", async () => {
    const f = fixture(5000);
    try {
      await f.connection.start(new AbortController().signal);
      const result = f.connection
        .read(cursor, new AbortController().signal)
        .catch((error) => error);
      await flush();
      f.begin();
      const timer = vi.spyOn(globalThis, "setTimeout");
      vi.spyOn(performance, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1025);
      f.send("{}\n"); // Complete body, missing end, no remaining buffered bytes.
      expect(timer).toHaveBeenCalledTimes(1);
      expect(timer.mock.calls[0]![1]).toBe(4975);
      await vi.advanceTimersByTimeAsync(4974);
      expect(f.closed()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ message: "Native journal reply phase deadline" });
      expect(f.closed()).toBe(true);
    } finally {
      await f.connection.dispose();
    }
  });

  it("keeps the five-second payload watchdog non-sliding after a long parked wait", async () => {
    const f = fixture(5000);
    try {
      await f.connection.start(new AbortController().signal);
      const result = f.connection
        .read(cursor, new AbortController().signal)
        .catch((error) => error);
      await flush();
      f.begin();
      await vi.advanceTimersByTimeAsync(120000);
      f.send("{");
      await vi.advanceTimersByTimeAsync(4000);
      f.send(" ");
      await vi.advanceTimersByTimeAsync(999);
      expect(f.closed()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ message: "Native journal reply phase deadline" });
      expect(f.closed()).toBe(true);
    } finally {
      await f.connection.dispose();
    }
  });

  it.each(["missing-begin", "partial-begin", "partial-payload", "missing-end"])(
    "bounds %s after a completed handshake",
    async (mode) => {
      const f = fixture();
      try {
        await f.connection.start(new AbortController().signal);
        expect(f.connection.connectionId).toBe("8");
        const result = f.connection.read(cursor, new AbortController().signal).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await flush();
        expect(f.writes).toHaveLength(1); // Explicit dispatch barrier.
        if (mode === "partial-begin") f.send("%beg");
        if (mode === "partial-payload") {
          f.begin();
          f.send("{");
        }
        if (mode === "missing-end") {
          f.begin();
          f.send("{}\n");
        }
        await vi.advanceTimersByTimeAsync(100);
        expect(await result).toMatchObject({
          error: expect.objectContaining({ message: "Native journal reply phase deadline" }),
        });
        expect(f.closed()).toBe(true);
        await expect(f.connection.read(cursor, new AbortController().signal)).rejects.toThrow();
      } finally {
        await f.connection.dispose();
      }
    },
  );

  it("does not slide the payload deadline on later partial bytes", async () => {
    const f = fixture();
    try {
      await f.connection.start(new AbortController().signal);
      const result = f.connection
        .read(cursor, new AbortController().signal)
        .catch((error) => error);
      await flush();
      f.begin();
      f.send("{");
      for (let index = 0; index < 4; index++) {
        await vi.advanceTimersByTimeAsync(20);
        f.send(" ");
      }
      await vi.advanceTimersByTimeAsync(20);
      expect(await result).toMatchObject({ message: "Native journal reply phase deadline" });
      expect(f.closed()).toBe(true);
    } finally {
      await f.connection.dispose();
    }
  });

  it("keeps a valid begun idle wait alive for two old lease periods then consumes one reply", async () => {
    const f = fixture();
    try {
      await f.connection.start(new AbortController().signal);
      let settled = false;
      const result = f.connection.read(cursor, new AbortController().signal).finally(() => {
        settled = true;
      });
      await flush();
      f.begin();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      expect(f.closed()).toBe(false);
      expect(mocked.spawn).toHaveBeenCalledTimes(1);
      f.send("{}\n%end 2 2 1\n");
      expect(await result).toBe("{}");
      expect(f.writes).toHaveLength(1);
      expect(f.connection.connectionId).toBe("8");
    } finally {
      await f.connection.dispose();
    }
  });
});
