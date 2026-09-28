import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NativeTmuxInteractionObserver,
  type NativeJournalObserverEvent,
} from "./native-tmux-interaction-observer.ts";
const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("native observer test timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function fixture(waitMs = 1000) {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-native-reader-"));
  const socket = join(root, "owned.sock");
  const run = (...args: string[]) =>
    execFileSync(binary!, ["-S", socket, ...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const start = () => run("-f", "/dev/null", "new-session", "-d", "-s", "probe", "cat");
  start();
  const [pid, startTime] = run("display-message", "-p", "#{pid}\t#{start_time}").split("\t");
  const events: NativeJournalObserverEvent[] = [];
  const observer = new NativeTmuxInteractionObserver({
    tmuxAuthority: { executablePath: binary!, socketSelector: { kind: "path", path: socket } },
    nativeServerIdentity: { pid: pid!, startTime: startTime! },
    enable: true,
    onEvent: (event) => events.push(event),
    timing: { waitMs, retryMs: 20, maxRetryMs: 40 },
  });
  const capability = () => JSON.parse(run("tmux-ide-events", "-V"));
  return {
    run,
    start,
    observer,
    events,
    capability,
    async close() {
      await observer.dispose();
      try {
        run("kill-server");
      } catch {
        /* already stopped */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
describe.skipIf(!binary)("native observer with isolated production tmux", () => {
  it("reads real command/effect metadata in bounded batches and cancels its waiter", async () => {
    const f = fixture();
    try {
      expect(f.capability().enabled).toBe(false);
      expect(await f.observer.start()).toBe("ready");
      await until(() => f.capability().waitingReaders === 1);
      const args: string[] = [];
      for (let i = 0; i < 100; i++) {
        if (i) args.push(";");
        args.push("send-keys", "-t", "probe", "-l", "x");
      }
      f.run(...args);
      await until(
        () =>
          f.events
            .filter((e) => e.type === "batch")
            .flatMap((e) => (e.type === "batch" ? e.batch.records : [])).length === 200,
      );
      const batches = f.events.filter((e) => e.type === "batch");
      expect(batches.length).toBeGreaterThanOrEqual(4);
      for (const e of batches)
        if (e.type === "batch") expect(e.batch.records.length).toBeLessThanOrEqual(64);
      await until(() => f.capability().waitingReaders === 1);
      await f.observer.dispose();
      await until(() => f.capability().waitingReaders === 0);
    } finally {
      await f.close();
    }
  }, 15000);
  it("surfaces actual overwritten history instead of silently skipping it", async () => {
    const f = fixture();
    try {
      f.run("tmux-ide-events", "-e");
      const args: string[] = [];
      for (let i = 0; i < 128; i++) {
        if (i) args.push(";");
        args.push("send-keys", "-t", "probe", "-l", "x");
      }
      for (let i = 0; i < 17; i++) f.run(...args);
      await f.observer.start();
      await until(() => f.events.some((e) => e.type === "gap"));
      const gap = f.events.find((e) => e.type === "gap");
      expect(gap?.type === "gap" && gap.missing).toEqual({ from: "1", through: "256" });
    } finally {
      await f.close();
    }
  }, 15000);
  it("does not enable or follow a replacement server at the same path", async () => {
    const f = fixture();
    try {
      await f.observer.start();
      await until(() => f.capability().waitingReaders === 1);
      f.run("kill-server");
      f.start();
      await until(() => f.observer.status === "retrying");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(f.capability().enabled).toBe(false);
      expect(f.events.some((e) => e.type === "batch")).toBe(false);
    } finally {
      await f.close();
    }
  }, 15000);
  it("keeps a native idle waiter alive beyond the runner's old five second cap", async () => {
    const f = fixture(10000);
    try {
      await f.observer.start();
      await until(() => f.capability().waitingReaders === 1);
      await new Promise((resolve) => setTimeout(resolve, 5500));
      expect(f.observer.status).toBe("ready");
      expect(f.events.some((event) => event.type === "state" && event.status === "retrying")).toBe(
        false,
      );
      expect(f.capability().waitingReaders).toBe(1);
    } finally {
      await f.close();
    }
  }, 15000);
});
