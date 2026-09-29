/** Private bounded fixture evidence; diagnostic failure never authorizes skipping cleanup. */
import assert from "node:assert/strict";
import type { Readable, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
  lstatSync,
  unlinkSync,
} from "node:fs";

export function readSparkPrivateLog(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert(
      stat.isFile() && stat.uid === process.getuid?.() && !(stat.mode & 0o077) && stat.nlink === 1,
    );
    const size = Math.min(stat.size, 64 * 1024);
    const bytes = Buffer.alloc(size);
    const count = readSync(fd, bytes, 0, size, stat.size - size);
    return {
      bytes: count,
      truncated: stat.size > size,
      text: bytes.subarray(0, count).toString("utf8"),
    };
  } finally {
    closeSync(fd);
  }
}

export async function preserveSparkDiagnostic(
  capture: () => unknown | Promise<unknown>,
  save: (value: unknown) => void,
  timeoutMs = 2000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(capture),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("Diagnostic capture deadline")), timeoutMs);
      }),
    ]);
    // Save only the winning result: a capture settling after timeout cannot write.
    save(value);
    return { captured: true as const };
  } catch {
    try {
      save({ captured: false, code: "diagnostic-capture-failed" });
    } catch {
      /* Keep cleanup unconditional. */
    }
    return { captured: false as const };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createSparkRouteLifecycle(
  now = () => performance.now(),
  wallNow = () => Date.now(),
) {
  const startedAtMs = wallNow();
  const started = now();
  let stopRequested = false;
  return {
    stop: () => {
      stopRequested = true;
    },
    closed: (code: number | null, signal: NodeJS.Signals | null, spawnError: boolean) => ({
      state: "closed" as const,
      startedAtMs,
      closedAtMs: wallNow(),
      code,
      signal,
      spawnError,
      stopRequested,
      elapsedMs: Math.max(0, Math.round(now() - started)),
    }),
  };
}

/** Drain arbitrary stderr while writing at most64KiB to one exclusive private file. */
export function createSparkPrivateStderr(path: string) {
  let fd: number | undefined;
  let bytes = 0,
    truncated = false,
    captureFailed = false;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    captureFailed = true;
  }
  return {
    write(chunk: Buffer) {
      const count = Math.min(chunk.length, 64 * 1024 - bytes);
      if (count < chunk.length) truncated = true;
      if (fd === undefined || captureFailed) return;
      try {
        let offset = 0;
        while (offset < count) {
          const written = writeSync(fd, chunk, offset, count - offset);
          if (written <= 0) throw Error("No diagnostic write progress");
          offset += written;
        }
        bytes += count;
      } catch {
        captureFailed = true;
      }
    },
    close() {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          captureFailed = true;
        }
        fd = undefined;
      }
      return { bytes, truncated, captureFailed };
    },
  };
}

/** Existing product diagnostic stream goes through a nonblocking FIFO; disk writes stay capped. */
export function createSparkTuiLogCapture(pipe: string, destination: string) {
  let fd: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let failed = false;
  const sink = createSparkPrivateStderr(destination);
  const drain = () => {
    if (fd === undefined) return;
    const bytes = Buffer.alloc(16384);
    for (let turn = 0; turn < 64; turn++) {
      try {
        const count = readSync(fd, bytes, 0, bytes.length, null);
        if (!count) break;
        sink.write(bytes.subarray(0, count));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") failed = true;
        break;
      }
    }
  };
  const close = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    drain();
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        failed = true;
      }
      fd = undefined;
    }
    if (identity) {
      try {
        const current = lstatSync(pipe);
        if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(pipe);
        else failed = true;
      } catch {
        failed = true;
      }
      identity = undefined;
    }
    return { ...sink.close(), pipeFailed: failed };
  };
  try {
    execFileSync("/usr/bin/mkfifo", ["-m", "600", pipe], {
      timeout: 1000,
      killSignal: "SIGKILL",
      stdio: "pipe",
      maxBuffer: 4096,
    });
    const stat = lstatSync(pipe);
    assert(stat.isFIFO() && stat.uid === process.getuid?.() && !(stat.mode & 0o077));
    identity = { dev: stat.dev, ino: stat.ino };
    fd = openSync(pipe, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    timer = setInterval(drain, 25);
    timer.unref();
    return { path: pipe, close };
  } catch {
    failed = true;
    close();
    return null;
  }
}

/** Original stderr remains visible to production; pipe preserves ordering/backpressure. */
export function teeSparkRouteStderr(
  source: Readable,
  destination: Writable,
  capture: { write(chunk: Buffer): void },
) {
  source.on("data", (chunk: Buffer) => capture.write(chunk));
  source.pipe(destination, { end: false });
}
