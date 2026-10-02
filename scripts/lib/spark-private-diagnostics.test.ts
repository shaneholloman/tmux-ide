import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  teeSparkRouteStderr,
  createSparkTuiLogCapture,
  createSparkPrivateStderr,
  createSparkRouteLifecycle,
  preserveSparkDiagnostic,
  readSparkPrivateLog,
} from "./spark-private-diagnostics.ts";

test("private stderr is capped while excess data is drained and file failures stay diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "spark-diagnostics-"));
  try {
    const path = join(root, "stderr");
    const sink = createSparkPrivateStderr(path);
    sink.write(Buffer.alloc(100000, 120));
    sink.write(Buffer.alloc(100000, 121));
    assert.deepEqual(sink.close(), { bytes: 65536, truncated: true, captureFailed: false });
    assert.equal(statSync(path).size, 65536);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const refused = createSparkPrivateStderr(path);
    refused.write(Buffer.from("overwrite"));
    assert.equal(refused.close().captureFailed, true);
    assert.equal(readFileSync(path)[0], 120);
    const log = join(root, "owner.log");
    writeFileSync(log, Buffer.alloc(100000, 122), { mode: 0o600 });
    assert.equal(readSparkPrivateLog(log).bytes, 65536);
    assert.equal(readSparkPrivateLog(log).truncated, true);
    symlinkSync(log, join(root, "link"));
    assert.throws(() => readSparkPrivateLog(join(root, "link")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lifecycle distinguishes requested termination, exit status and spawn failure without messages", () => {
  let now = 10;
  const lifecycle = createSparkRouteLifecycle(
    () => now,
    () => 1000,
  );
  lifecycle.stop();
  now = 60;
  assert.deepEqual(lifecycle.closed(null, "SIGTERM", false), {
    state: "closed",
    startedAtMs: 1000,
    closedAtMs: 1000,
    code: null,
    signal: "SIGTERM",
    spawnError: false,
    stopRequested: true,
    elapsedMs: 50,
  });
  assert.equal(createSparkRouteLifecycle(() => 0).closed(255, null, false).stopRequested, false);
  assert.equal(createSparkRouteLifecycle(() => 0).closed(null, null, true).spawnError, true);
});

test("capture rejection, failed saves and unresolved capture cannot prevent following cleanup", async () => {
  let cleanup = 0;
  for (const capture of [
    () => {
      throw Error("private");
    },
    () => new Promise(() => {}),
  ]) {
    const result = await preserveSparkDiagnostic(
      capture,
      () => {
        throw Error("disk failure");
      },
      5,
    );
    cleanup++;
    assert.equal(result.captured, false);
  }
  assert.equal(cleanup, 2);
  let finish!: (value: unknown) => void;
  const saved: unknown[] = [];
  await preserveSparkDiagnostic(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    (value) => saved.push(value),
    5,
  );
  finish({ secret: "must not be saved late" });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(saved, [{ captured: false, code: "diagnostic-capture-failed" }]);
});

test("existing TUI diagnostic FIFO drains into bounded private file and retires on close", () => {
  const root = mkdtempSync(join(tmpdir(), "spark-log-pipe-"));
  try {
    const pipe = join(root, "events.pipe"),
      output = join(root, "events.jsonl");
    const capture = createSparkTuiLogCapture(pipe, output);
    assert(capture);
    writeFileSync(pipe, '{"phase":"startup-failed","reason":"unavailable"}\n');
    const result = capture.close();
    assert.equal(result.pipeFailed, false);
    assert.match(readFileSync(output, "utf8"), /startup-failed/);
    assert.throws(() => statSync(pipe));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("route stderr tee preserves byte ordering, backpressure and destination lifetime", async () => {
  const source = new PassThrough();
  const forwarded: Buffer[] = [];
  const copied: Buffer[] = [];
  const destination = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      forwarded.push(Buffer.from(chunk));
      queueMicrotask(done);
    },
  });
  teeSparkRouteStderr(source, destination, {
    write(chunk) {
      copied.push(Buffer.from(chunk));
    },
  });
  const end = once(source, "end");
  source.write(Buffer.from([0, 255, 10]));
  source.end(Buffer.from("last"));
  await end;
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat(copied));
  assert.deepEqual(Buffer.concat(forwarded), Buffer.from([0, 255, 10, 108, 97, 115, 116]));
  assert.equal(destination.writableEnded, false);
  destination.end();
});

test(
  "stalled collector leaves lifecycle writes bounded and resumes actual logger shutdown",
  { timeout: 5000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-log-shutdown-"));
    const previous = process.env.TMUX_IDE_TUI_LOG;
    const previousPerf = process.env.TMUX_IDE_TUI_PERF_LOG;
    const capture = createSparkTuiLogCapture(join(root, "events.pipe"), join(root, "events.jsonl"));
    assert(capture);
    process.env.TMUX_IDE_TUI_LOG = capture.path;
    delete process.env.TMUX_IDE_TUI_PERF_LOG;
    try {
      const logger =
        await import("../../packages/daemon/src/tui/mirror/runtime/application-performance-log.ts");
      assert.equal(logger.tuiPerfStream, null);
      // No event-loop yield: the collector cannot drain during this burst. The actual
      // product writer must drop excess records, rather than block the caller.
      for (let index = 0; index < 10000; index++)
        logger.tuiPerfMark("generation-runtime-fault", { index, reason: "x".repeat(1024) });
      assert(logger.tuiPerfDiagnostics().droppedRecords > 0);
      await logger.closeTuiPerfMarks();
      const result = capture.close();
      assert.equal(result.pipeFailed, false);
      assert(statSync(join(root, "events.jsonl")).size <= 65536);
      assert.match(readFileSync(join(root, "events.jsonl"), "utf8"), /generation-runtime-fault/);
    } finally {
      capture.close();
      if (previous === undefined) delete process.env.TMUX_IDE_TUI_LOG;
      else process.env.TMUX_IDE_TUI_LOG = previous;
      if (previousPerf === undefined) delete process.env.TMUX_IDE_TUI_PERF_LOG;
      else process.env.TMUX_IDE_TUI_PERF_LOG = previousPerf;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
