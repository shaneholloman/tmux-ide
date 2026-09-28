import { createFleetPreviewCapture } from "../command-center/resources/fleet-preview-route.ts";
import { discoverLiveSessionSummaries } from "../command-center/discovery.ts";
import { createTmuxAgentStatusProbe } from "../terminal/attachments/agent-status-probe.ts";
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
  "routes background preview and status callers through passive native proof",
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

      const capture = createBackgroundNativeCapture({
        environmentId,
        serverScope,
        observation: () => observer!,
        runPinnedTmux: createServerGenerationFencedTmuxAsyncRunner(authority, nativeServerIdentity),
      });
      const runAsync = createServerGenerationFencedTmuxAsyncRunner(authority, nativeServerIdentity);
      const liveId = discoverLiveSessionSummaries((args) => run(...args))[0]!.liveSessionId;
      const preview = createFleetPreviewCapture(runAsync, {
        serverEpoch: () => observer!.nativeServerEpoch,
        capture,
      });
      expect(await preview(liveId)).toBe("\n".repeat(23));
      const nativeIdentity = {
        serverEpoch: observer.nativeServerEpoch!,
        paneBirthId: paneBirthId!,
      };
      const probe = createTmuxAgentStatusProbe({
        run: runAsync,
        readProcessTable: async () => [],
        manifests: [{ id: "fixture", commands: ["sleep"], states: {} }],
        captureNative: (pane, signal) =>
          capture(
            {
              paneId: pane.runtimePaneId,
              nativeIdentity: pane.nativeIdentity ?? null,
              mode: "agent-status",
            },
            signal,
          ),
      });
      await probe.probe({
        sessionId: "$0",
        nowSec: Math.floor(Date.now() / 1000),
        panes: [
          { runtimePaneId: paneId!, nativeIdentity, currentCommand: "sleep", title: "fixture" },
        ],
      });
      await vi.waitFor(() =>
        expect(
          evidence.filter(
            (e) => e.actor.kind === "native" && e.actor.classification.kind === "viewer",
          ),
        ).toHaveLength(2),
      );
      expect(layout()).toBe(before);
      const owned = evidence.filter(
        (e) => e.actor.kind === "native" && e.actor.classification.kind === "viewer",
      );
      expect(owned).toHaveLength(2);
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
