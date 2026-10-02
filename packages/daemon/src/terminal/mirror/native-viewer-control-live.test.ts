import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  MirrorControlChannel,
  type NativeViewerControlReply,
  type NativeViewerControlRequest,
} from "./control-channel.ts";
const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)(
  "retained viewer wrapper preserves capture, hook and failed-child FIFO boundaries on native tmux",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-viewer-control-")),
      socket = join(dir, "owned.sock");
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TMUX: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    let channel: MirrorControlChannel | undefined;
    try {
      run(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "probe",
        "printf 'CAPTURE_LINE\\n'; sleep 60",
      );
      const capability = JSON.parse(run("tmux-ide-events", "-e"));
      expect(capability.ownedOperationPaneGuard).toBe("direct-pane-v1");
      const [paneId, paneBirthId, pid, startTime] = run(
        "display-message",
        "-p",
        "-t",
        "probe",
        "#{pane_id}\t#{pane_birth_id}\t#{pid}\t#{start_time}",
      )
        .trim()
        .split("\t") as [string, string, string, string];
      await vi.waitFor(() =>
        expect(run("capture-pane", "-p", "-t", paneId)).toContain("CAPTURE_LINE"),
      );
      const expected = run("capture-pane", "-p", "-t", paneId).split("\n").slice(0, -1);
      run(
        "set-hook",
        "-g",
        "after-capture-pane",
        "display-message -p HOOK_OUTPUT ; display-message -p SECOND_HOOK_OUTPUT",
      );
      const retired = vi.fn(),
        registered = vi.fn(() => true);
      channel = new MirrorControlChannel({
        session: "probe",
        socketPath: socket,
        executable: binary,
        nativeServerIdentity: { pid, startTime },
        handlers: { onOutput: vi.fn(), onNotify: vi.fn(), onExit: vi.fn() },
        nativeViewer: {
          serverEpoch: capability.serverEpoch,
          onIdentity: registered,
          onRetired: retired,
        },
      });
      await channel.start();
      expect(registered).toHaveBeenCalledTimes(1);
      const invoke = (
        commands: readonly (readonly string[])[],
        resultIndex = commands.length - 1,
        targetBirth = paneBirthId,
      ) =>
        new Promise<NativeViewerControlReply>((resolve, reject) => {
          const request: NativeViewerControlRequest = {
            operationId: randomUUID(),
            paneId,
            paneBirthId: targetBirth,
            commands,
            resultIndex,
            limits: { maxBytes: 65536, maxLines: 1024 },
          };
          if (!channel!.commandNativeViewerInline(request, resolve))
            reject(new Error("not dispatched"));
        });
      const capture = invoke([["capture-pane", "-p", "-t", paneId]]);
      const afterCapture = channel.request("display-message -p AFTER_CAPTURE");
      expect(await capture).toMatchObject({ ok: true, lines: expected, metadataStatus: "valid" });
      await expect(afterCapture).resolves.toEqual(["AFTER_CAPTURE"]);
      const failure = invoke([
        ["display-message", "-p", "before"],
        ["capture-pane", "-p", "-t", "%4294967295"],
        ["display-message", "-p", "SHOULD_NOT_RUN"],
      ]);
      const afterFailure = channel.request("display-message -p AFTER_CHILD_ERROR");
      expect(await failure).toMatchObject({ ok: false, metadataStatus: "valid" });
      await expect(afterFailure).resolves.toEqual(["AFTER_CHILD_ERROR"]);
      const guardFailure = invoke(
        [["set-option", "-g", "@viewer-must-not-run", "yes"]],
        0,
        String(BigInt(paneBirthId) + 1n),
      );
      const afterGuard = channel.request("display-message -p AFTER_GUARD_ERROR");
      expect(await guardFailure).toMatchObject({
        ok: false,
        metadataStatus: "unavailable",
        acknowledgement: null,
      });
      await expect(afterGuard).resolves.toEqual(["AFTER_GUARD_ERROR"]);
      expect(run("show-options", "-gqv", "@viewer-must-not-run")).toBe("");
      expect(channel.pendingCount).toBe(0);
      await channel.dispose();
      expect(retired).toHaveBeenCalledTimes(1);
      channel = undefined;
    } finally {
      await channel?.dispose();
      try {
        run("kill-server");
      } catch {
        /* Disposable server may already have exited. */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
