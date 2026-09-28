import { NativeJournalCapabilitySchemaZ } from "@tmux-ide/contracts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MirrorControlChannel, type NativeViewerControlReply } from "./control-channel.ts";
import {
  decodeNativeAtomicDualSnapshot,
  nativeAtomicDualSnapshotPlan,
} from "./native-atomic-snapshot.ts";
import { PaneFeed, seedBytesFromCapture } from "./pane-feed.ts";
const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary).each(["", "A\\n\\n", "\\033[31mwide界\\033[0m\\n", "1234567890".repeat(12)])(
  "dual snapshot matches ordinary control capture bytes for %j",
  async (content) => {
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
      run(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "snapshot",
        `printf '${content}'; sleep 60`,
      );
      const capability = NativeJournalCapabilitySchemaZ.parse(
        JSON.parse(run("tmux-ide-events", "-e")),
      );
      expect(capability.atomicPaneSnapshotDual).toBe("capture-resume-dual-v2");
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
      // Wait for the deterministic startup command to settle before comparing two captures.
      await vi.waitFor(() =>
        expect(run("display-message", "-p", "-t", paneId, "#{pane_current_command}").trim()).toBe(
          "sleep",
        ),
      );
      const ordinary = await channel.request(`capture-pane -p -e -J -S - -t '${paneId}'`);
      await channel.request(`refresh-client -A '${paneId}:pause'`);
      const plan = nativeAtomicDualSnapshotPlan(target);
      const reply = await new Promise<NativeViewerControlReply>((resolve, reject) => {
        if (!channel!.commandNativeViewerInline({ ...plan, operationId: randomUUID() }, resolve))
          reject(new Error("native dispatch declined"));
      });
      expect(reply.metadataStatus).toBe("valid");
      const result = decodeNativeAtomicDualSnapshot(reply, target);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") throw new Error("invalid dual snapshot");
      const feed = new PaneFeed(),
        epoch = feed.beginReseed();
      feed.captureDualReply(epoch, result.capture, result.ansiCapture);
      const seed = feed
        .cursorReply(epoch, result.cursorLine)
        .find((event) => event.type === "seed");
      expect(seed?.type === "seed" && seed.data).toEqual(seedBytesFromCapture(ordinary));
      expect(seed?.type === "seed" && seed.native).toEqual(result.capture);
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
