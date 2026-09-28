import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeJournalControlConnection } from "./native-journal-control-connection.ts";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
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
function fixture() {
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
    100,
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
  });
  afterEach(() => vi.useRealTimers());

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
