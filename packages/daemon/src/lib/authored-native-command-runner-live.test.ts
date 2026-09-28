import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { NativeJournalIdentity, NativeOperationIdentity } from "@tmux-ide/contracts";
import type { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import type { AuthoredNativeCommandRequest } from "./workspace-multiplexer-verbs.ts";
import { createAuthoredNativeCommandRunner } from "./authored-native-command-runner.ts";
import { createPinnedWorkspaceTmuxRunner } from "./workspace-pane-creation.ts";
import { shellEscape } from "./shell.ts";

const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)(
  "preserves metadata-looking capture bytes and partial failure proof on a real private connection",
  async () => {
    const dir = mkdtempSync("/tmp/tmux-authored-proof-");
    const socket = join(dir, "s");
    const native = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, ...args], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TMUX: "" },
      });
    try {
      const payload =
        '{"schemaVersion":2,"type":"identity","connectionId":"999"}\n{"type":"operation-identity","operationId":"fake"}\nCAPTURE-END\n\n';
      native(
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        "proof",
        `printf %s ${shellEscape(payload)}; sleep 60`,
      );
      await vi.waitFor(() =>
        expect(native("capture-pane", "-p", "-t", "proof")).toContain("CAPTURE-END"),
      );
      const capability = JSON.parse(native("tmux-ide-events", "-e"));
      const [pane, birth] = native(
        "display-message",
        "-p",
        "-t",
        "proof",
        "#{pane_id}\t#{pane_birth_id}",
      )
        .trimEnd()
        .split("\t");
      const id = randomUUID();
      const scope = { serverId: `tmux-server.${"a".repeat(32)}`, generation: randomUUID() };
      const observer = {
        ownedOperationTransport: true,
        ownedOperationEpochGuard: capability.ownedOperationEpochGuard === "server-epoch-v1",
        ownedOperationPaneGuard: capability.ownedOperationPaneGuard === "direct-pane-v1",
        nativeServerEpoch: capability.serverEpoch,
        admitOwnedOperation: vi.fn(() => ({ operationId: id })),
        registerOwnedConnection: vi.fn((_identity: NativeJournalIdentity) => ({ bindingId: id })),
        acknowledgeOwnedOperation: vi.fn(
          (_permit: unknown, _connection: unknown, _ack: NativeOperationIdentity) => {},
        ),
        closeOwnedConnection: vi.fn(),
        noteOwnedOperationUncertainty: vi.fn(),
      };
      const runTmux = vi.fn(
        createPinnedWorkspaceTmuxRunner({
          executablePath: binary!,
          socketSelector: { kind: "path", path: socket },
        }),
      );
      const runner = createAuthoredNativeCommandRunner({
        environmentId: id,
        serverScope: scope,
        observation: () => observer as unknown as OwnerInteractionObservation,
        runPinnedTmux: runTmux,
      });
      const request: AuthoredNativeCommandRequest = {
        operationId: id,
        targetPaneId: pane!,
        targetBirthId: birth!,
        expectedKinds: ["capture-pane"],
        commands: [["capture-pane", "-p", "-e", "-J", "-S", "-2000", "-t", pane!]],
        context: {
          executionId: id,
          authoredReceiptAdmissionSequence: 1,
          origin: "sdk",
          interactionContext: {
            destination: {
              kind: "pane",
              environmentId: id,
              serverScope: scope,
              workspaceName: "proof",
              semanticPaneId: "pane.proof",
              paneLifetimeId: randomUUID(),
            },
            source: null,
          },
        },
      };
      const expected = native(...request.commands[0]!);
      expect(runner(request)).toEqual({ output: expected });
      expect(runTmux).toHaveBeenCalledTimes(1);
      const identity = observer.registerOwnedConnection.mock.calls[0]![0];
      const ack = observer.acknowledgeOwnedOperation.mock.calls[0]![2];
      expect(identity.connectionId).toBe(ack.connectionId);
      expect(identity.serverEpoch).toBe(capability.serverEpoch);
      expect(ack.operationId).toBe(id);
      expect(observer.closeOwnedConnection).toHaveBeenCalledTimes(1);

      // The first child succeeds; the second fails. Classified subprocess failure
      // must preserve its original failure while retaining the private prefix proof.
      runTmux.mockClear();
      observer.acknowledgeOwnedOperation.mockClear();
      expect(() =>
        runner({
          ...request,
          expectedKinds: ["send-keys"],
          commands: [
            ["set-buffer", "-b", "once", "--", ";"],
            ["send-keys", "-t", "%4294967295", "Enter"],
          ],
        }),
      ).toThrow();
      expect(runTmux).toHaveBeenCalledTimes(1);
      expect(native("save-buffer", "-b", "once", "-")).toBe(";");
      expect(observer.acknowledgeOwnedOperation).toHaveBeenCalledTimes(1);
      expect(observer.closeOwnedConnection).toHaveBeenCalledTimes(2);

      // Refusal is before the supplied body, even its non-pane first command.
      for (const mismatch of ["birth", "epoch"] as const) {
        runTmux.mockClear();
        observer.acknowledgeOwnedOperation.mockClear();
        observer.nativeServerEpoch = mismatch === "epoch" ? randomUUID() : capability.serverEpoch;
        expect(() =>
          runner({
            ...request,
            targetBirthId: mismatch === "birth" ? String(BigInt(birth!) + 1n) : birth!,
            commands: [["set-buffer", "-b", "must-not-exist", "--", "guarded-body"]],
            expectedKinds: ["send-keys"],
          }),
        ).toThrow();
        expect(runTmux).toHaveBeenCalledTimes(1);
        expect(observer.acknowledgeOwnedOperation).not.toHaveBeenCalled();
        expect(() => native("save-buffer", "-b", "must-not-exist", "-")).toThrow();
      }
    } finally {
      try {
        native("kill-server");
      } catch {
        /* disposable server already exited */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
