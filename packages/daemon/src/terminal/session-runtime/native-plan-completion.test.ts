import { expect, it, vi } from "vitest";
import type { NativeJournalRecord } from "@tmux-ide/contracts";
import {
  OwnedNativeInteractionBindings,
  type OwnedNativePlanCompletion,
} from "../../lib/owned-native-interaction-bindings.ts";
import { NativeInteractionProjector } from "../../lib/native-interaction-projector.ts";
import { InteractionReceiptJournal } from "../../lib/interaction-receipt-journal.ts";
import { testInteractionContext } from "../../../test-support/interaction-evidence.ts";
import {
  SessionSemanticMutationExecutor,
  type SessionRuntimeIntentResult,
} from "./semantic-mutation-executor.ts";
const id = "00000000-0000-4000-8000-000000000005";
const intent = {
  verb: "workspace.pane.send",
  workspaceName: "w",
  semanticPaneId: "pane.one",
  text: "x",
  submit: false,
  origin: "sdk",
} as const;
const context = testInteractionContext(intent);
function proof(
  destination = context.destination,
  command: "send-keys" | "capture-pane" = "send-keys",
): OwnedNativePlanCompletion {
  const { environmentId, serverScope } = destination;
  let completion!: OwnedNativePlanCompletion;
  const authority = new OwnedNativeInteractionBindings({
    environmentId,
    serverScope,
    serverEpoch: id,
    onPlanComplete: (value) => {
      completion = value;
    },
  });
  const permit = authority.admit({
    operationId: id,
    role: "authored",
    target: { kind: "native-pane", environmentId, serverScope, serverEpoch: id, paneBirthId: "1" },
    authoredDestination: destination,
    source: null,
    commands: [command],
  })!;
  const connection = authority.registerConnection(
    { schemaVersion: 2, type: "identity", serverEpoch: id, connectionId: "7" },
    "authored",
  )!;
  authority.acknowledge(permit, connection, {
    schemaVersion: 2,
    type: "operation-identity",
    serverEpoch: id,
    connectionId: "7",
    wrapperCommandId: "8",
    operationId: id,
  });
  const record: NativeJournalRecord = {
    sequence: "1",
    kind: command === "send-keys" ? 1 : 2,
    commandId: "9",
    issuerId: "7",
    requestId: "5",
    parentCommandId: "8",
    monotonicUs: "100",
    count: "0",
    targetId: 0,
    targetBirthId: "1",
    outcome: 1,
    flags: 1,
    transport: 1,
    derivation: 1,
    correlation: id,
  };
  const projector = new NativeInteractionProjector({ environmentId, serverScope, serverEpoch: id });
  authority.ingestBatch(
    projector.consume({
      schemaVersion: 2,
      type: "batch",
      serverEpoch: id,
      journalEpoch: id,
      oldest: "1",
      newest: "1",
      next: "1",
      degraded: 0,
      gap: null,
      records: [record],
    }),
  );
  authority.dispose();
  expect(completion).toBeDefined();
  return completion;
}
function rig() {
  let finish!: (value: SessionRuntimeIntentResult) => void;
  let fail!: (error: Error) => void;
  const execute = vi.fn(
    () =>
      new Promise<SessionRuntimeIntentResult>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const journal = new InteractionReceiptJournal();
  const executor = new SessionSemanticMutationExecutor({
    captureInteractionContext: () => context,
    resolveSession: () => "session",
    execute,
    publishReceipt: (draft) => journal.publish(draft),
    observationTimeoutMs: 100,
  });
  const result = executor.submit(id, intent, { origin: "sdk" });
  return {
    executor,
    execute,
    journal,
    result,
    finish: () =>
      finish({
        verb: intent.verb,
        operationId: id,
        daemonInstanceId: id,
        workspaceName: "w",
        outcome: "applied",
        sourceSemanticPaneId: null,
        semanticPaneId: "pane.one",
        origin: "sdk",
        characterCount: 1,
        byteCount: 1,
        submitted: false,
      }),
    fail: () => fail(new Error("readback failed")),
  };
}
it("native completion releases only the existing barrier and still waits for primitive readback", async () => {
  const r = rig();
  await vi.waitFor(() => expect(r.execute).toHaveBeenCalledOnce());
  const exact = proof();
  expect(r.executor.observeOwnedNativePlan(structuredClone(exact))).toBe(false);
  expect(
    r.executor.observeOwnedNativePlan(proof({ ...context.destination, paneLifetimeId: id })),
  ).toBe(false);
  for (const destination of [
    { ...context.destination, environmentId: id },
    { ...context.destination, serverScope: { ...context.destination.serverScope, generation: id } },
    { ...context.destination, workspaceName: "another" },
    { ...context.destination, semanticPaneId: "pane.other" },
  ])
    expect(r.executor.observeOwnedNativePlan(proof(destination))).toBe(false);
  expect(r.executor.observeOwnedNativePlan(proof(context.destination, "capture-pane"))).toBe(false);
  expect(r.executor.observeOwnedNativePlan(exact)).toBe(true);
  expect(r.journal.latestOperationReceipt(id)?.phase).toBe("accepted");
  r.finish();
  await r.result;
  expect(r.journal.latestOperationReceipt(id)?.phase).toBe("observed");
  expect(r.executor.observeOwnedNativePlan(exact)).toBe(false);
  expect(r.execute).toHaveBeenCalledOnce();
  await r.executor.dispose();
  r.journal.dispose();
});
it("a complete native plan cannot hide later primitive failure", async () => {
  const r = rig();
  const rejected = expect(r.result).rejects.toThrow("tmux rejected");
  await vi.waitFor(() => expect(r.execute).toHaveBeenCalledOnce());
  expect(r.executor.observeOwnedNativePlan(proof())).toBe(true);
  r.fail();
  await rejected;
  expect(r.journal.latestOperationReceipt(id)?.phase).toBe("rejected");
  expect(r.executor.observeOwnedNativePlan(proof())).toBe(false);
  await r.executor.dispose();
  r.journal.dispose();
});
