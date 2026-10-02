import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NativeTmuxInteractionObserver } from "./native-tmux-interaction-observer.ts";
import {
  NativeInteractionProjector,
  type NativeInteractionProjection,
} from "./native-interaction-projector.ts";
const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)(
  "projects real synchronized native effects across64record reader boundaries",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-ide-projector-"));
    const socket = join(root, "owned.sock");
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, ...args], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    let observer: NativeTmuxInteractionObserver | undefined;
    try {
      run("-f", "/dev/null", "new-session", "-d", "-s", "probe", "cat");
      run("split-window", "-h", "-d", "-t", "probe", "cat");
      run("set-window-option", "-t", "probe", "synchronize-panes", "on");
      const [pid, startTime] = run("display-message", "-p", "#{pid}\t#{start_time}").split("\t");
      const cap = JSON.parse(run("tmux-ide-events", "-V"));
      const projector = new NativeInteractionProjector({
        environmentId: "00000000-0000-4000-8000-000000000001",
        serverScope: {
          serverId: `tmux-server.${"a".repeat(32)}`,
          generation: "00000000-0000-4000-8000-000000000002",
        },
        serverEpoch: cap.serverEpoch,
      });
      const projections: NativeInteractionProjection[] = [];
      observer = new NativeTmuxInteractionObserver({
        tmuxAuthority: { executablePath: binary!, socketSelector: { kind: "path", path: socket } },
        nativeServerIdentity: { pid: pid!, startTime: startTime! },
        enable: true,
        onEvent(event) {
          if (event.type === "batch") projections.push(...projector.consume(event.batch));
          if (event.type === "reset")
            projections.push(...projector.reset(event.cursor.journalEpoch));
        },
      });
      await observer.start();
      const args: string[] = [];
      for (let i = 0; i < 70; i++) {
        if (i) args.push(";");
        args.push("send-keys", "-t", "probe.0", "-l", "abc");
      }
      run(...args);
      const end = Date.now() + 5000;
      while (projections.length < 140) {
        if (Date.now() > end) throw new Error("projector timeout");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(projections).toHaveLength(140);
      expect(new Set(projections.map((p) => p.evidence.interactionId)).size).toBe(140);
      expect(
        projections.every(
          (p) =>
            p.evidence.effect.kind === "input-enqueued" &&
            p.native.uncertainty === null &&
            p.native.record.count === "3",
        ),
      ).toBe(true);
      expect(
        projections.every((p) => p.evidence.endpoints.destination.kind === "native-pane"),
      ).toBe(true);
      expect(projector.pendingRecords).toBe(0);
      await observer.dispose();
      expect(projector.dispose()).toEqual([]);
    } finally {
      await observer?.dispose();
      try {
        run("kill-server");
      } catch {
        /*owned server already gone*/
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
