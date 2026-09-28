import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const spawned = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawned.spawn }));
import {
  ControlChannelCore,
  MirrorControlChannel,
  type NativeViewerControlRequest,
} from "./control-channel.ts";
const serverEpoch = "11111111-1111-4111-8111-111111111111",
  operationId = "22222222-2222-4222-8222-222222222222";
const identity = {
  schemaVersion: 2 as const,
  type: "identity" as const,
  serverEpoch,
  connectionId: "7",
};
const ack = {
  schemaVersion: 2,
  type: "operation-identity",
  serverEpoch,
  connectionId: "7",
  wrapperCommandId: "8",
  operationId,
};
const request: NativeViewerControlRequest = {
  operationId,
  paneId: "%1",
  paneBirthId: "2",
  commands: [["capture-pane", "-p", "-t", "%1"]],
  resultIndex: 0,
  limits: { maxBytes: 4096, maxLines: 16 },
};
const block = (id: number, lines: string[] = [], ok = true, flags = 1) =>
  `%begin 1 ${id} ${flags}\n${lines.length ? lines.join("\n") + "\n" : ""}%${ok ? "end" : "error"} 1 ${id} ${flags}\n`;
function core() {
  return new ControlChannelCore({ onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() });
}
function fixture(options?: { onIdentity?: (i: typeof identity) => boolean; configured?: boolean }) {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
  });
  const writes: string[] = [];
  proc.stdin.on("data", (chunk) => {
    const text = chunk.toString();
    writes.push(text);
    if (text === "detach-client\n")
      queueMicrotask(() => {
        proc.exitCode = 0;
        proc.emit("exit", 0);
      });
  });
  spawned.spawn.mockReturnValueOnce(proc);
  const onRetired = vi.fn(),
    onIdentity = vi.fn(options?.onIdentity ?? (() => true));
  const channel = new MirrorControlChannel({
    session: "test",
    handlers: { onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() },
    ...(options?.configured === false
      ? {}
      : { nativeViewer: { serverEpoch, onIdentity, onRetired } }),
  });
  return { channel, proc, writes, onRetired, onIdentity };
}
async function start(
  f: ReturnType<typeof fixture>,
  response = JSON.stringify(identity),
  ok = true,
) {
  const pending = f.channel.start();
  f.proc.stdout.write(block(1, [], true, 0));
  await Promise.resolve();
  if (f.writes.some((s) => s === "tmux-ide-events -i\n"))
    f.proc.stdout.write(block(2, [response], ok));
  await pending;
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("native viewer identity lifetime", () => {
  it("keeps stock transport unchanged without owner capability", async () => {
    const f = fixture({ configured: false });
    await start(f);
    expect(f.writes).toEqual([]);
    expect(f.channel.nativeViewerIdentity).toBeNull();
    expect(f.channel.commandNativeViewerInline(request, vi.fn())).toBe(false);
    await f.channel.dispose();
    expect(f.onRetired).not.toHaveBeenCalled();
  });
  it.each(["foreign", "malformed", "unsupported", "registration"])(
    "disables optional proof on %s without breaking ordinary FIFO",
    async (mode) => {
      const f = fixture({ onIdentity: () => mode !== "registration" });
      await start(
        f,
        mode === "foreign"
          ? JSON.stringify({ ...identity, serverEpoch: operationId })
          : mode === "malformed"
            ? "bad"
            : JSON.stringify(identity),
        mode !== "unsupported",
      );
      expect(f.channel.nativeViewerIdentity).toBeNull();
      expect(f.channel.commandNativeViewerInline(request, vi.fn())).toBe(false);
      const ordinary = f.channel.request("display-message -p normal");
      f.proc.stdout.write(block(3, ["normal"]));
      await expect(ordinary).resolves.toEqual(["normal"]);
      await f.channel.dispose();
      expect(f.onRetired).toHaveBeenCalledTimes(1);
    },
  );
  it("uses the actual connection identity and retires once across exit/dispose; replacement re-handshakes", async () => {
    const f = fixture();
    await start(f);
    expect(f.onIdentity).toHaveBeenCalledWith(identity);
    const returned = f.channel.nativeViewerIdentity!;
    returned.connectionId = "999";
    expect(f.channel.nativeViewerIdentity?.connectionId).toBe("7");
    f.proc.exitCode = 0;
    f.proc.emit("exit", 0);
    expect(f.channel.nativeViewerIdentity).toBeNull();
    await f.channel.dispose();
    expect(f.onRetired).toHaveBeenCalledTimes(1);
    await expect(f.channel.start()).rejects.toThrow("restart");
    const next = fixture();
    await start(next, JSON.stringify({ ...identity, connectionId: "9" }));
    expect(next.channel.nativeViewerIdentity?.connectionId).toBe("9");
    await next.channel.dispose();
  });
  it("bounds stalled identity and ignores its late reply", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.channel.start();
    f.proc.stdout.write(block(1, [], true, 0));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    f.proc.stdout.write(block(2, [JSON.stringify(identity)]));
    expect(f.onIdentity).not.toHaveBeenCalled();
    expect(f.channel.nativeViewerIdentity).toBeNull();
    f.proc.exitCode = 0;
    await f.channel.dispose();
    expect(f.onRetired).toHaveBeenCalledTimes(1);
  });
  it("writes one guarded operation, supports current input chunk size, and never retries after uncertainty", async () => {
    const f = fixture();
    await start(f);
    const done = vi.fn();
    expect(
      f.channel.commandNativeViewerInline(
        { ...request, commands: [["send-keys", "-t", "%1", "-H", ...Array(256).fill("61")]] },
        done,
      ),
    ).toBe(true);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]).toContain("'-E'");
    expect(f.writes[1]).toContain("'-B'");
    f.proc.stdout.write(block(3, [JSON.stringify({ ...ack, connectionId: "99" })]) + block(4));
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, metadataStatus: "invalid", acknowledgement: null }),
    );
    expect(f.writes).toHaveLength(2);
    expect(
      f.channel.commandNativeViewerInline(
        { ...request, commands: [["run-shell", "evil"]] },
        vi.fn(),
      ),
    ).toBe(false);
    await f.channel.dispose();
  });
});
describe("native wrapper FIFO boundaries", () => {
  it("consumes bounded acknowledgement separately, preserves exact selected rows, and fires inline", () => {
    const c = core(),
      done = vi.fn(),
      onAck = vi.fn();
    c.pushNativeWrapper(
      { ...identity, operationId },
      { ...request, onAcknowledgement: onAck },
      done,
    );
    const next = vi.fn();
    c.push({ kind: "inline", onReply: next, lines: [] });
    const rows = ["", "%output is literal capture text", JSON.stringify(ack), "  keep spaces  "];
    c.feed(block(1, [JSON.stringify(ack)]));
    expect(onAck).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    c.feed(block(2, rows) + block(3, ["next"]));
    expect(done).toHaveBeenCalledWith({
      ok: true,
      lines: rows,
      metadataStatus: "valid",
      acknowledgement: ack,
    });
    expect(next).toHaveBeenCalledWith({ ok: true, lines: ["next"] });
    expect(c.pendingCount).toBe(0);
  });
  it.each([0, 1])("drops only the failed wrapper group at block index %i", (index) => {
    const c = core(),
      done = vi.fn(),
      next = vi.fn();
    c.pushNativeWrapper(
      { ...identity, operationId },
      {
        ...request,
        commands: [
          ["display-message", "-p", "one"],
          ["capture-pane", "-p"],
        ],
        resultIndex: 1,
      },
      done,
    );
    c.push({ kind: "inline", onReply: next, lines: [] });
    if (index) c.feed(block(1, [JSON.stringify(ack)]));
    c.feed(block(2, ["failed"], false) + block(3, ["next"]));
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0]![0].ok).toBe(false);
    expect(next).toHaveBeenCalledWith({ ok: true, lines: ["next"] });
    expect(c.pendingCount).toBe(0);
  });
  it("ignores hook reply blocks and bounds invalid acknowledgement without swallowing capture", () => {
    const c = core(),
      done = vi.fn();
    c.pushNativeWrapper({ ...identity, operationId }, request, done);
    c.feed(block(1, ["x".repeat(1025)]));
    c.feed(block(2, ["hook secret"], true, 0));
    c.feed(block(3, ["snapshot"]));
    expect(done).toHaveBeenCalledWith({
      ok: true,
      lines: ["snapshot"],
      metadataStatus: "invalid",
      acknowledgement: null,
    });
    expect(c.pendingCount).toBe(0);
  });
  it("caps captured rows and completes once on channel failure", () => {
    const c = core(),
      done = vi.fn();
    c.pushNativeWrapper(
      { ...identity, operationId },
      { ...request, limits: { maxBytes: 3, maxLines: 1 } },
      done,
    );
    c.feed(block(1, [JSON.stringify(ack)]) + block(2, ["too long"]));
    expect(done.mock.calls[0]![0]).toMatchObject({ ok: false, lines: [], metadataStatus: "valid" });
    c.fail("gone");
    expect(done).toHaveBeenCalledTimes(1);
  });
});
