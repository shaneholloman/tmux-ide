import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import { InteractionReceiptJournal } from "./interaction-receipt-journal.ts";
import { InteractionObservationStatusStore } from "./interaction-observation-status.ts";
import { AuthoredNativeReceiptEnricher } from "./authored-native-receipt-staging.ts";
import { createAuthoredNativeCommandRunner } from "./authored-native-command-runner.ts";
import { createPinnedWorkspaceTmuxRunner } from "./workspace-pane-creation.ts";
import { WorkspaceMultiplexerAuthority } from "./workspace-multiplexer-verbs.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";
import { SessionSemanticMutationExecutor } from "../terminal/session-runtime/semantic-mutation-executor.ts";

const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)(
  "completes authored send/read through real native outcomes without stock hooks",
  async () => {
    const dir = mkdtempSync("/tmp/native-completion-");
    const socket = join(dir, "s");
    const native = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, ...args], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TMUX: "" },
      });
    const environmentId = randomUUID();
    const generation = randomUUID();
    const scope = { serverId: `tmux-server.${"a".repeat(32)}`, generation };
    const journal = new InteractionReceiptJournal();
    const status = new InteractionObservationStatusStore(environmentId, scope);
    const metadataFailures: unknown[] = [];
    const enricher = new AuthoredNativeReceiptEnricher({
      journal,
      publishRaw: (e) => journal.appendEvidence(e),
      noteGap: () => metadataFailures.push("gap"),
      onFailure: (e) => metadataFailures.push(e),
    });
    let owner: OwnerInteractionObservation | undefined;
    let executor: SessionSemanticMutationExecutor | undefined;
    try {
      native("-f", "/dev/null", "new-session", "-d", "-s", "proof", "cat");
      native("new-window", "-d", "-t", "proof", "-n", "keep", "cat");
      const pane = native("display-message", "-p", "-t", "proof:0", "#{pane_id}").trim();
      native("set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.proof");
      const [pid, startTime] = native("display-message", "-p", "#{pid}\t#{start_time}")
        .trim()
        .split("\t");
      const authority = {
        executablePath: binary!,
        socketSelector: { kind: "path" as const, path: socket },
      };
      const pinned = createPinnedWorkspaceTmuxRunner(authority);
      const completed: string[] = [];
      owner = new OwnerInteractionObservation({
        environmentId,
        serverScope: scope,
        tmuxAuthority: authority,
        nativeServerIdentity: { pid: pid!, startTime: startTime! },
        enabled: true,
        status,
        publishEvidence: (e) => journal.appendEvidence(e),
        publishOwnedEvidence: (d) => enricher.consume(d),
        onOwnedPlanComplete: (proof) => {
          if (executor!.observeOwnedNativePlan(proof))
            completed.push(proof.acknowledgement.operationId);
        },
      });
      const runner = createAuthoredNativeCommandRunner({
        environmentId,
        serverScope: scope,
        observation: () => owner!,
        runPinnedTmux: pinned,
      });
      const registry = new WorkspaceRegistry({
        dir: join(dir, "registry"),
        listSessions: () => ["proof"],
      });
      registry.add({ name: "proof", sessionName: "proof", projectDir: dir });
      const dispatched: string[][][] = [];
      const multiplexer = new WorkspaceMultiplexerAuthority({
        daemonInstanceId: generation,
        registry,
        io: {
          runTmux: pinned,
          canonicalProjectDir: (p) => p,
          runAuthoredNative: (request, options) => {
            dispatched.push(request.commands.map((c) => [...c]));
            return runner(request, options);
          },
        },
      });
      const context = {
        destination: {
          kind: "pane" as const,
          environmentId,
          serverScope: scope,
          workspaceName: "proof",
          semanticPaneId: "pane.proof",
          paneLifetimeId: randomUUID(),
        },
        source: null,
      };
      executor = new SessionSemanticMutationExecutor({
        captureInteractionContext: () => context,
        resolveSession: () => "proof",
        execute: (id, intent, timing, execution) =>
          intent.verb === "workspace.pane.read"
            ? multiplexer.readPane(id, intent, execution)
            : multiplexer.mutate(
                { operationId: id, expectedDaemonInstanceId: generation, intent },
                timing,
                execution,
              ),
        publishReceipt: (r) => journal.publish(r),
        observationTimeoutMs: 1500,
      });
      await owner.start();
      await vi.waitFor(() => expect(owner!.ownedOperationPaneGuard).toBe(true));
      expect(native("show-hooks", "-g")).not.toContain("tmux_ide");
      const sendId = randomUUID();
      const send = {
        verb: "workspace.pane.send" as const,
        workspaceName: "proof",
        semanticPaneId: "pane.proof",
        origin: "sdk" as const,
        text: "NATIVE-ONLY-COMPLETION",
        submit: true,
      };
      await expect(executor.submit(sendId, send, { origin: "sdk" })).resolves.toMatchObject({
        verb: send.verb,
        outcome: "applied",
      });
      expect(completed).toContain(sendId);
      const dispatchCount = dispatched.length;
      await executor.submit(sendId, send, { origin: "sdk" });
      expect(dispatched.length).toBe(dispatchCount);
      // Enqueue proof is not application-consumption proof. Wait for the fixture's
      // terminal echo independently before asserting the later snapshot text.
      await vi.waitFor(() =>
        expect(native("capture-pane", "-p", "-t", pane)).toContain("NATIVE-ONLY-COMPLETION"),
      );
      const readId = randomUUID();
      const read = {
        verb: "workspace.pane.read" as const,
        workspaceName: "proof",
        semanticPaneId: "pane.proof",
        origin: "sdk" as const,
      };
      const result = await executor.submit(readId, read, { origin: "sdk" });
      expect(result).toMatchObject({ availability: "available" });
      expect(result && "text" in result && result.text).toContain("NATIVE-ONLY-COMPLETION");
      expect(completed).toContain(readId);
      expect(dispatched.flat().some((command) => command[0] === "set-option")).toBe(false);
      expect(native("show-options", "-p", "-t", pane)).not.toContain("@tmux_ide_internal_");
      expect(await executor.submit(readId, read, { origin: "sdk" })).toMatchObject({
        availability: "replay-unavailable",
        text: null,
      });

      await vi.waitFor(() => {
        for (const op of [sendId, readId])
          expect(journal.latestOperationReceipt(op)?.evidence?.observation.kind).toBe(
            "native-journal",
          );
      });
      expect(JSON.stringify(journal.read(0))).not.toContain("NATIVE-ONLY-COMPLETION");
      expect(metadataFailures).toEqual([]);
      // A paste can succeed before a user hook deletes the pane. Enter must fail,
      // the semantic operation stays rejected, and replay never dispatches it again.
      native("set-hook", "-g", "after-paste-buffer", `kill-pane -t ${pane}`);
      const partial = randomUUID();
      await expect(
        executor.submit(partial, { ...send, text: "PARTIAL" }, { origin: "sdk" }),
      ).rejects.toThrow();
      const afterPartial = dispatched.length;
      await expect(
        executor.submit(partial, { ...send, text: "PARTIAL" }, { origin: "sdk" }),
      ).rejects.toThrow();
      expect(dispatched.length).toBe(afterPartial);
      expect(completed).not.toContain(partial);
      expect(journal.latestOperationReceipt(partial)?.phase).toBe("rejected");
    } finally {
      await owner?.dispose();
      await executor?.dispose();
      enricher.dispose();
      journal.dispose();
      status.dispose();
      try {
        native("kill-server");
      } catch {
        /* owned server already exited */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
