import { NativeJournalCapabilitySchemaZ } from "@tmux-ide/contracts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MirrorControlChannel, type NativeViewerControlReply } from "./control-channel.ts";
import { decodeNativeAtomicSnapshot, nativeAtomicSnapshotPlan } from "./native-atomic-snapshot.ts";
const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)(
  "decodes a bounded full native Q snapshot from the actual paused issuer",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "tmux-atomic-decode-"));
    const socket = join(directory, "server.sock");
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TMUX: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    let channel: MirrorControlChannel | undefined;
    try {
      run("-f", "/dev/null", "new-session", "-d", "-s", "snapshot", "cat");
      const capability = NativeJournalCapabilitySchemaZ.parse(
        JSON.parse(run("tmux-ide-events", "-e")),
      );
      expect(capability.atomicPaneSnapshot).toBe("capture-resume-v1");
      const [paneId, paneBirthId, pid, startTime] = run(
        "display-message",
        "-p",
        "-t",
        "snapshot",
        "#{pane_id}\t#{pane_birth_id}\t#{pid}\t#{start_time}",
      )
        .trim()
        .split("\t") as [string, string, string, string];
      const target = { serverEpoch: capability.serverEpoch, paneId, paneBirthId };
      const notifications: string[] = [];
      channel = new MirrorControlChannel({
        session: "snapshot",
        executable: binary!,
        socketPath: socket,
        nativeServerIdentity: { pid, startTime },
        handlers: {
          onOutput: vi.fn(),
          onExit: vi.fn(),
          onNotify: (name) => {
            notifications.push(name);
          },
        },
        nativeViewer: {
          serverEpoch: target.serverEpoch,
          onIdentity: () => true,
          onRetired: vi.fn(),
        },
      });
      await channel.start();
      await channel.request(`refresh-client -A '${paneId}:pause'`);
      const plan = nativeAtomicSnapshotPlan(target);
      const reply = await new Promise<NativeViewerControlReply>((resolve, reject) => {
        if (!channel!.commandNativeViewerInline({ ...plan, operationId: randomUUID() }, resolve))
          reject(new Error("native dispatch declined"));
      });
      expect(reply.metadataStatus).toBe("valid");
      expect(decodeNativeAtomicSnapshot(reply, target)).toMatchObject({
        status: "ok",
        inlineContinue: true,
      });
      // Native Q commits its continue within the selected child frame.
      expect(reply.lines.at(-1)).toBe(`%continue ${paneId}`);
      expect(notifications).not.toContain("continue");
    } finally {
      try {
        await channel?.dispose();
      } finally {
        try {
          run("kill-server");
        } catch {
          /* private server may already be gone */
        }
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
  15000,
);
