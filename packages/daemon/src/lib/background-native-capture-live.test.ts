import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { InteractionEvidence } from "@tmux-ide/contracts";
import { createBackgroundNativeCapture } from "./background-native-capture.ts";
import { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import { InteractionObservationStatusStore } from "./interaction-observation-status.ts";
import { createServerGenerationFencedTmuxAsyncRunner } from "./tmux-server-generation-runner.ts";
const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)(
  "classifies passive one-shot native captures without attach, resizing or plaintext evidence",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-background-capture-")),
      socket = join(root, "s");
    const run = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, ...args], { encoding: "utf8", timeout: 5000 });
    const environmentId = "11111111-1111-4111-8111-111111111111",
      serverScope = { serverId: `tmux-server.${"a".repeat(32)}`, generation: environmentId };
    const status = new InteractionObservationStatusStore(environmentId, serverScope),
      evidence: InteractionEvidence[] = [];
    let observer: OwnerInteractionObservation | undefined;
    try {
      run("-f", "/dev/null", "new-session", "-d", "-s", "probe", "sleep 60");
      const [pid, startTime, paneId, paneBirthId] = run(
        "display-message",
        "-p",
        "#{pid}\t#{start_time}\t#{pane_id}\t#{pane_birth_id}",
      )
        .trim()
        .split("\t");
      const authority = {
          executablePath: binary!,
          socketSelector: { kind: "path" as const, path: socket },
        },
        nativeServerIdentity = { pid: pid!, startTime: startTime! };
      observer = new OwnerInteractionObservation({
        environmentId,
        serverScope,
        tmuxAuthority: authority,
        nativeServerIdentity,
        enabled: true,
        status,
        publishEvidence: (e) => evidence.push(e),
      });
      await observer.start();
      expect(observer.selection).toBe("native");
      const layout = () =>
        run(
          "display-message",
          "-p",
          "#{window_layout}\t#{window_id}\t#{pane_id}\t#{session_attached}",
        );
      const before = layout();
      const snapshot = run("capture-pane", "-p", "-t", paneId!, "-S", "-24");
      const capture = createBackgroundNativeCapture({
        environmentId,
        serverScope,
        observation: () => observer!,
        runPinnedTmux: createServerGenerationFencedTmuxAsyncRunner(authority, nativeServerIdentity),
      });
      expect(
        await capture({
          paneId: paneId!,
          nativeIdentity: { serverEpoch: observer.nativeServerEpoch!, paneBirthId: paneBirthId! },
          mode: "fleet-preview",
        }),
      ).toEqual({ output: snapshot });
      await vi.waitFor(() =>
        expect(
          evidence.some(
            (e) => e.actor.kind === "native" && e.actor.classification.kind === "viewer",
          ),
        ).toBe(true),
      );
      expect(layout()).toBe(before);
      const owned = evidence.filter(
        (e) => e.actor.kind === "native" && e.actor.classification.kind === "viewer",
      );
      expect(owned).toHaveLength(1);
      expect(owned[0]!.effect.kind).toBe("snapshot-produced");
      expect(owned[0]!.endpoints.source).toBeNull();
      expect(JSON.stringify(owned)).not.toContain('"text"');
      expect(status.getSnapshot().lastGap).toBeNull();
    } finally {
      await observer?.dispose();
      status.dispose();
      try {
        run("kill-server");
      } catch {
        /* already stopped */
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
