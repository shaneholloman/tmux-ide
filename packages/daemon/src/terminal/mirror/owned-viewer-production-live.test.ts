import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { InteractionEvidence } from "@tmux-ide/contracts";
import { OwnerInteractionObservation } from "../../lib/owner-interaction-observation.ts";
import { InteractionObservationStatusStore } from "../../lib/interaction-observation-status.ts";
import { createOwnedViewerAdapterFactory } from "../../lib/owned-viewer-factory.ts";
import { nativeInteractionReference } from "../../lib/native-interaction-projector.ts";
import { MirrorService } from "./mirror-service.ts";

const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)(
  "real owner and MirrorService classify only attached viewer input/capture across isolated scopes",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "tmux-viewer-production-"));
    const environmentId = randomUUID();
    const servers: Array<(...args: string[]) => string> = [];
    const rows: Array<{
      service: MirrorService;
      owner: OwnerInteractionObservation;
      status: InteractionObservationStatusStore;
      run: (...args: string[]) => string;
      evidence: InteractionEvidence[];
      serverEpoch: string;
      viewerIssuer: string;
    }> = [];
    try {
      for (const [index, label] of ["default", "nondefault"].entries()) {
        const socket = join(directory, `${label}.sock`);
        const run = (...args: string[]) =>
          execFileSync(binary!, ["-S", socket, ...args], {
            encoding: "utf8",
            timeout: 5000,
            env: { ...process.env, TMUX: "" },
            stdio: ["ignore", "pipe", "pipe"],
          });
        servers.push(run);
        run("-f", "/dev/null", "new-session", "-d", "-s", "probe", "cat");
        const [paneId, sessionId, pid, startTime] = run(
          "display-message",
          "-p",
          "-t",
          "probe",
          "#{pane_id}\t#{session_id}\t#{pid}\t#{start_time}",
        )
          .trim()
          .split("\t") as [string, string, string, string];
        // Same semantic stamps and runtime IDs on both servers deliberately exercise scope collisions.
        run("set-option", "-p", "-t", paneId, "@tmux_ide_pane_id", "pane.viewer");
        run("set-option", "-w", "-t", "probe", "@tmux_ide_window_id", "window.viewer");
        const serverScope = {
          serverId: `tmux-server.${String(index + 1).repeat(32)}`,
          generation: randomUUID(),
        };
        const status = new InteractionObservationStatusStore(environmentId, serverScope);
        const evidence: InteractionEvidence[] = [];
        const owner = new OwnerInteractionObservation({
          environmentId,
          serverScope,
          status,
          enabled: true,
          nativeServerIdentity: { pid, startTime },
          tmuxAuthority: {
            executablePath: binary!,
            socketSelector: { kind: "path", path: socket },
          },
          publishEvidence: (value) => {
            evidence.push(value);
          },
        });
        const register = vi.spyOn(owner, "registerOwnedConnection");
        const close = vi.spyOn(owner, "closeOwnedConnection");
        const service = new MirrorService({
          executable: binary!,
          socketPath: socket,
          nativeServerIdentity: { pid, startTime },
          createOwnedViewerAdapter: createOwnedViewerAdapterFactory({
            environmentId,
            serverScope,
            observation: owner,
            status,
          }),
        });
        const row = { service, owner, status, run, evidence, serverEpoch: "", viewerIssuer: "" };
        rows.push(row);
        // Start real attached control before native observation readiness, then enable via its event subscription.
        const retained = await service.retainSession("probe");
        await service.describeTrustedInventory("probe", sessionId);
        expect(register).not.toHaveBeenCalled();
        await owner.start();
        await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1), { timeout: 5000 });
        const [viewerIdentity, role] = register.mock.calls[0]!;
        expect(role).toBe("viewer");
        expect(viewerIdentity.connectionId).not.toBe("0");
        row.serverEpoch = viewerIdentity.serverEpoch;
        row.viewerIssuer = nativeInteractionReference([
          environmentId,
          serverScope.serverId,
          serverScope.generation,
          viewerIdentity.serverEpoch,
          "issuer",
          viewerIdentity.connectionId,
        ]);
        const subscription = await service.subscribe({
          session: "probe",
          semanticPaneId: "pane.viewer",
          nativeBootstrap: true,
          onEvent: () => {},
        });
        subscription.sendText(`VIEWER_${label}`);
        subscription.sendKey("Enter");
        const backing = await subscription.captureNativeBacking();
        expect(["captured", "changed"]).toContain(backing.status);
        // This separate ordinary CLI connection is NOT the viewer, despite the same target and overlapping timing.
        const raw = run("tmux-ide-events", "-i", ";", "capture-pane", "-p", "-t", paneId);
        const rawIdentity = JSON.parse(raw.split("\n")[0]!);
        const rawIssuer = nativeInteractionReference([
          environmentId,
          serverScope.serverId,
          serverScope.generation,
          viewerIdentity.serverEpoch,
          "issuer",
          rawIdentity.connectionId,
        ]);
        expect(rawIssuer).not.toBe(row.viewerIssuer);
        await vi.waitFor(
          () => {
            const viewer = evidence.filter(
              (value) =>
                value.actor.kind === "native" && value.actor.classification.kind === "viewer",
            );
            expect(viewer.some((value) => value.effect.kind === "input-enqueued")).toBe(true);
            expect(viewer.some((value) => value.effect.kind === "snapshot-produced")).toBe(true);
            expect(
              viewer.every(
                (value) =>
                  value.actor.kind === "native" && value.actor.issuerId === row.viewerIssuer,
              ),
            ).toBe(true);
            expect(
              evidence.some(
                (value) =>
                  value.actor.kind === "native" &&
                  value.actor.issuerId === rawIssuer &&
                  value.actor.classification.kind === "unknown" &&
                  value.effect.kind === "snapshot-produced",
              ),
            ).toBe(true);
          },
          { timeout: 5000 },
        );
        expect(
          evidence.every(
            (value) => value.endpoints.destination.serverScope.serverId === serverScope.serverId,
          ),
        ).toBe(true);
        await subscription.close();
        await retained.close();
        await service.dispose();
        expect(close).toHaveBeenCalledTimes(1);
        await owner.dispose();
        const count = evidence.length;
        run("capture-pane", "-p", "-t", paneId);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(evidence).toHaveLength(count);
        expect(run("list-clients", "-F", "#{client_control_mode}").trim()).toBe("");
      }
      expect(rows[0]!.serverEpoch).not.toBe(rows[1]!.serverEpoch);
      expect(rows[0]!.viewerIssuer).not.toBe(rows[1]!.viewerIssuer);
    } finally {
      await Promise.allSettled(
        rows.map(async (row) => {
          try {
            await row.service.dispose();
          } finally {
            try {
              await row.owner.dispose();
            } finally {
              row.status.dispose();
            }
          }
        }),
      );
      for (const run of servers) {
        try {
          run("kill-server");
        } catch {
          /* private server may already be gone */
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);
