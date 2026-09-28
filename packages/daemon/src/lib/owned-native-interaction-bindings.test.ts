import { expect, it, vi } from "vitest";
import type { NativeJournalRecord } from "@tmux-ide/contracts";
import { NativeInteractionProjector } from "./native-interaction-projector.ts";
import {
  OwnedNativeInteractionBindings,
  isOwnedNativePlanCompletion,
} from "./owned-native-interaction-bindings.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const environmentId = id(1),
  serverEpoch = id(3),
  journalEpoch = id(4),
  operationId = id(5);
const serverScope = { serverId: `tmux-server.${"a".repeat(32)}`, generation: id(2) };
const target = {
  kind: "native-pane" as const,
  environmentId,
  serverScope,
  serverEpoch,
  paneBirthId: "1",
};
const identity = {
  schemaVersion: 2 as const,
  type: "identity" as const,
  serverEpoch,
  connectionId: "7",
};
const ack = {
  schemaVersion: 2 as const,
  type: "operation-identity" as const,
  serverEpoch,
  connectionId: "7",
  wrapperCommandId: "8",
  operationId,
};
function projection(extra: Partial<NativeJournalRecord> = {}, effect = true, capture = false) {
  const record = (sequence: string, kind: number): NativeJournalRecord => ({
    sequence,
    kind,
    commandId: "9",
    issuerId: "7",
    requestId: "5",
    parentCommandId: "8",
    monotonicUs: "100",
    count: kind >= 5 ? "3" : "0",
    targetId: 0,
    targetBirthId: "1",
    outcome: 1,
    flags: 1,
    transport: 1,
    derivation: 1,
    correlation: operationId,
    ...extra,
  });
  const records = effect
    ? [record("1", capture ? 6 : 5), record("2", capture ? 2 : 1)]
    : [record("1", capture ? 2 : 1)];
  return new NativeInteractionProjector({ environmentId, serverScope, serverEpoch }).consume({
    schemaVersion: 2,
    type: "batch",
    serverEpoch,
    journalEpoch,
    oldest: "1",
    newest: records.at(-1)!.sequence,
    next: records.at(-1)!.sequence,
    degraded: 0,
    gap: null,
    records,
  })[0]!;
}
function setup(
  options: Partial<ConstructorParameters<typeof OwnedNativeInteractionBindings>[0]> = {},
) {
  let now = 0;
  const authority = new OwnedNativeInteractionBindings({
    environmentId,
    serverScope,
    serverEpoch,
    now: () => now,
    ...options,
  });
  const connection = authority.registerConnection(identity, "viewer")!;
  const permit = authority.admit({
    operationId,
    role: "viewer",
    target,
    commands: ["send-keys"],
    source: null,
    connection,
  })!;
  return {
    authority,
    connection,
    permit,
    tick: (v: number) => {
      now = v;
    },
  };
}
it("acknowledges exact direct children without changing native facts", () => {
  const { authority, connection, permit } = setup(),
    item = projection();
  expect(authority.ingest(item)).toEqual([]);
  const result = authority.acknowledge(permit, connection, ack)[0]!;
  expect(result.disposition).toBe("viewer");
  expect(result.evidence.actor).toMatchObject({
    classification: { kind: "viewer", bindingId: connection.bindingId },
  });
  expect(result.evidence.observation).toEqual(item.evidence.observation);
  expect(result.evidence.effect).toEqual(item.evidence.effect);
  expect(result.evidence.interactionId).toBe(item.evidence.interactionId);
  expect(Object.isFrozen(result.evidence.endpoints.destination)).toBe(true);
});
it.each([
  { issuerId: "10" },
  { parentCommandId: "10" },
  { derivation: 2 },
  { correlation: id(8) },
  { targetBirthId: "2" },
  { requestId: "0" },
  { transport: 0 },
])("keeps unrelated activity unknown %j", (extra) => {
  const { authority, connection, permit } = setup();
  authority.acknowledge(permit, connection, ack);
  const item = projection(extra),
    result = authority.ingest(item)[0]!;
  expect(result.disposition).toBe("unknown");
  expect(result.evidence).toEqual(item.evidence);
});
it("never invents effects for command-only records", () => {
  const { authority, connection, permit } = setup();
  authority.acknowledge(permit, connection, ack);
  expect(authority.ingest(projection({}, false))[0]!.evidence.effect).toEqual({ kind: "unknown" });
});
it("rejects copied grants, wrong issuer acknowledgements and conflicting second acknowledgements", () => {
  const { authority, connection, permit } = setup();
  authority.ingest(projection());
  expect(authority.acknowledge({ ...permit }, connection, ack)).toEqual([]);
  expect(authority.acknowledge(permit, { ...connection }, ack)).toEqual([]);
  expect(authority.acknowledge(permit, connection, { ...ack, connectionId: "8" })).toEqual([]);
  expect(authority.size.pending).toBe(1);
  expect(authority.acknowledge(permit, connection, ack)[0]!.disposition).toBe("viewer");
  authority.acknowledge(permit, connection, { ...ack, wrapperCommandId: "10" });
  expect(authority.ingest(projection({ parentCommandId: "10" }))[0]!.disposition).toBe("unknown");
});
it("bounds pending entries and flushes expiry once without evidence loss", () => {
  const { authority, connection, permit, tick } = setup({
    maxPending: 1,
    pendingMs: 10,
    permitMs: 20,
  });
  const item = projection();
  authority.ingest(item);
  expect(authority.nextExpiryAt).toBe(10);
  expect(authority.ingest(item)[0]!.reason).toBe("overflow");
  tick(10);
  expect(() => authority.acknowledge(permit, connection, { ...ack, connectionId: "0" })).toThrow();
  expect(authority.expire()[0]!.evidence).toEqual(item.evidence);
  expect(authority.expire()).toEqual([]);
  tick(20);
  expect(authority.acknowledge(permit, connection, ack)).toEqual([]);
  expect(authority.nextExpiryAt).toBeNull();
});
it.each([false, true])(
  "retirement/disposal flushes staged evidence and rejects late proof (%s)",
  (dispose) => {
    const { authority, connection, permit } = setup();
    authority.ingest(projection());
    expect(
      (dispose ? authority.dispose() : authority.retireConnection(connection))[0]!.reason,
    ).toBe("retired");
    expect(authority.acknowledge(permit, connection, ack)).toEqual([]);
    expect(authority.ingest(projection())[0]!.disposition).toBe("unknown");
  },
);
it("rejects foreign target scope and caps allocations", () => {
  const { authority, connection } = setup({ maxConnections: 1, maxPermits: 1 });
  expect(authority.registerConnection({ ...identity, connectionId: "8" }, "viewer")).toBeNull();
  const request = {
    operationId: id(8),
    role: "viewer" as const,
    target,
    commands: ["send-keys" as const],
    source: null,
    connection,
  };
  expect(authority.admit(request)).toBeNull();
  expect(() =>
    authority.admit({ ...request, target: { ...target, serverEpoch: id(9) } }),
  ).toThrow();
  expect(() =>
    authority.admit({
      ...request,
      target: { ...target, serverScope: { ...serverScope, generation: id(9) } },
    }),
  ).toThrow();
});
it("authored helper closure retains exact proof until expiry then reclaims grants", () => {
  let now = 0;
  const authority = new OwnedNativeInteractionBindings({
    environmentId,
    serverScope,
    serverEpoch,
    now: () => now,
    maxConnections: 1,
    permitMs: 10,
  });
  const source = {
    endpoint: {
      kind: "pane" as const,
      environmentId,
      serverScope,
      paneLifetimeId: id(21),
      workspaceName: "other",
      semanticPaneId: "agent",
    },
    bindingId: id(22),
    agentRunId: id(23),
  };
  const request = {
    operationId,
    role: "authored" as const,
    target,
    commands: ["send-keys" as const],
    source,
  };
  const permit = authority.admit(request)!;
  const connection = authority.registerConnection(identity, "authored")!;
  authority.acknowledge(permit, connection, ack);
  authority.closeConnection(connection);
  expect(authority.admit({ ...request, operationId: id(8), connection })).toBeNull();
  const result = authority.ingest(projection())[0]!;
  expect(result.disposition).toBe("authored");
  expect(result.evidence.actor).toMatchObject({
    classification: { kind: "agent", bindingId: source.bindingId, agentRunId: source.agentRunId },
  });
  expect(result.evidence.endpoints.source).toEqual(source.endpoint);
  expect(authority.nextExpiryAt).toBeNull();
  now = 10;
  authority.expire();
  expect(authority.size.connections).toBe(0);
  expect(
    authority.registerConnection({ ...identity, connectionId: "8" }, "authored"),
  ).not.toBeNull();
  expect(authority.ingest(projection())[0]!.disposition).toBe("unknown");
});
it("retires completed viewer permits under sustained operation beyond admission capacity", () => {
  const { authority, connection } = setup();
  authority.dispose();
  const active = new OwnedNativeInteractionBindings({ environmentId, serverScope, serverEpoch });
  const viewer = active.registerConnection(identity, "viewer")!;
  for (let index = 0; index < 600; index++) {
    const op = id(100 + index),
      wrapper = String(1000 + index);
    const permit = active.admit({
      operationId: op,
      role: "viewer",
      target,
      commands: ["send-keys"],
      source: null,
      connection: viewer,
    });
    expect(permit).not.toBeNull();
    active.acknowledge(permit!, viewer, { ...ack, operationId: op, wrapperCommandId: wrapper });
    expect(
      active.ingest(projection({ correlation: op, parentCommandId: wrapper }))[0]!.disposition,
    ).toBe("viewer");
    expect(active.size.permits).toBe(0);
  }
  expect(connection).toBeDefined();
  expect(active.size.connections).toBe(1);
  active.dispose();
});
it("waits for paste plus Enter and counts distinct repeated command instances", () => {
  const { authority, connection } = setup();
  authority.dispose();
  const active = new OwnedNativeInteractionBindings({ environmentId, serverScope, serverEpoch });
  const viewer = active.registerConnection(identity, "viewer")!;
  const permit = active.admit({
    operationId,
    role: "viewer",
    target,
    commands: ["paste-buffer", "send-keys", "send-keys"],
    source: null,
    connection: viewer,
  })!;
  active.acknowledge(permit, viewer, ack);
  const paste = structuredClone(projection());
  paste.native.commandOutcome!.kind = 3;
  if (paste.evidence.observation.kind === "native-journal")
    paste.evidence.observation.command = "paste-buffer";
  expect(active.ingest(paste)[0]!.disposition).toBe("viewer");
  expect(active.size.permits).toBe(1);
  const enter = projection({ commandId: "10" });
  expect(active.ingest(enter)[0]!.disposition).toBe("viewer");
  expect(active.size.permits).toBe(1);
  active.ingest(enter);
  expect(active.size.permits).toBe(1);
  expect(active.ingest(projection({ commandId: "11" }))[0]!.disposition).toBe("viewer");
  expect(active.size.permits).toBe(0);
  expect(connection).toBeDefined();
});
it("classifies all effects from a completed native command before batch retirement", () => {
  const { authority, connection, permit } = setup();
  authority.acknowledge(permit, connection, ack);
  expect(
    authority.ingestBatch([projection(), projection()]).map((item) => item.disposition),
  ).toEqual(["viewer", "viewer"]);
  expect(authority.size.permits).toBe(0);
});
it("a reused UUID cannot correlate a retired wrapper's late record", () => {
  const { authority, connection, permit } = setup();
  authority.acknowledge(permit, connection, ack);
  authority.ingest(projection());
  expect(authority.hasPendingOperations).toBe(false);
  const next = authority.admit({
    operationId,
    role: "viewer",
    target,
    commands: ["send-keys"],
    source: null,
    connection,
  })!;
  authority.acknowledge(next, connection, { ...ack, wrapperCommandId: "20" });
  expect(authority.ingest(projection())[0]!.disposition).toBe("unknown");
  expect(authority.hasPendingOperations).toBe(true);
  expect(authority.ingest(projection({ parentCommandId: "20" }))[0]!.disposition).toBe("viewer");
  expect(authority.hasPendingOperations).toBe(false);
});
it("accepts only same-owner semantic admission destinations for authored proof", () => {
  const authority = new OwnedNativeInteractionBindings({ environmentId, serverScope, serverEpoch });
  const authoredDestination = {
    kind: "pane" as const,
    environmentId,
    serverScope,
    paneLifetimeId: id(70),
    workspaceName: "space",
    semanticPaneId: "pane.target",
  };
  const request = {
    operationId,
    role: "authored" as const,
    target,
    commands: ["send-keys" as const],
    source: null,
    executionId: id(99),
    authoredDestination,
  };
  expect(() =>
    authority.admit({
      ...request,
      executionId: id(99),
      authoredDestination: { ...authoredDestination, environmentId: id(80) },
    }),
  ).toThrow();
  expect(() => authority.admit({ ...request, role: "viewer" })).toThrow();
  const permit = authority.admit(request)!;
  const connection = authority.registerConnection(identity, "authored")!;
  authority.acknowledge(permit, connection, ack);
  expect(authority.ingest(projection())[0]!.proof!.authoredDestination).toEqual(
    authoredDestination,
  );
});
function completionRig() {
  let now = 0;
  const completed = vi.fn();
  const authority = new OwnedNativeInteractionBindings({
    environmentId,
    serverScope,
    serverEpoch,
    now: () => now,
    onPlanComplete: completed,
    permitMs: 100,
    pendingMs: 50,
  });
  const authoredDestination = {
    kind: "pane" as const,
    environmentId,
    serverScope,
    paneLifetimeId: id(70),
    workspaceName: "space",
    semanticPaneId: "pane.target",
  };
  const permit = authority.admit({
    operationId,
    role: "authored",
    target,
    commands: ["paste-buffer", "send-keys"],
    source: null,
    executionId: id(99),
    authoredDestination,
  })!;
  const connection = authority.registerConnection(identity, "authored")!;
  const command = (
    kind: "paste-buffer" | "send-keys",
    commandId: string,
    start: number,
    outcome = 1,
  ) => {
    const item = structuredClone(projection({ commandId }));
    item.native.record.sequence = String(start);
    item.native.commandOutcome!.sequence = String(start + 1);
    item.native.commandOutcome!.outcome = outcome;
    item.native.commandOutcome!.kind = kind === "paste-buffer" ? 3 : 1;
    if (item.evidence.observation.kind === "native-journal") {
      item.evidence.observation.command = kind;
      item.evidence.observation.cursor.sequence = String(start);
    }
    return item;
  };
  return {
    authority,
    connection,
    permit,
    completed,
    command,
    tick: (v: number) => {
      now = v;
    },
  };
}
it("emits one branded frozen completion only after full paste and Enter outcomes across batches", () => {
  const r = completionRig();
  r.authority.acknowledge(r.permit, r.connection, ack);
  r.authority.ingest(r.command("paste-buffer", "9", 1));
  expect(r.completed).not.toHaveBeenCalled();
  r.authority.ingest(r.command("send-keys", "10", 3));
  expect(r.completed).toHaveBeenCalledTimes(1);
  const proof = r.completed.mock.calls[0]![0];
  expect(isOwnedNativePlanCompletion(proof)).toBe(true);
  expect(isOwnedNativePlanCompletion({ ...proof })).toBe(false);
  expect(Object.isFrozen(proof.commands)).toBe(true);
  expect(proof.commands.map((c: { kind: string }) => c.kind)).toEqual([
    "paste-buffer",
    "send-keys",
  ]);
  r.authority.ingest(r.command("send-keys", "10", 3));
  expect(r.completed).toHaveBeenCalledTimes(1);
  expect(r.authority.hasPendingOperations).toBe(false);
});
it("staged proof before acknowledgement emits completion only after verified acknowledgement", () => {
  const r = completionRig();
  r.authority.ingestBatch([r.command("paste-buffer", "9", 1), r.command("send-keys", "10", 3)]);
  expect(r.completed).not.toHaveBeenCalled();
  r.authority.acknowledge(r.permit, r.connection, ack);
  expect(r.completed).toHaveBeenCalledTimes(1);
});
it.each([2, 3])(
  "error/wait outcome %s never completes despite partial input effects",
  (outcome) => {
    const r = completionRig();
    r.authority.acknowledge(r.permit, r.connection, ack);
    r.authority.ingestBatch([
      r.command("paste-buffer", "9", 1),
      r.command("send-keys", "10", 3, outcome),
    ]);
    expect(r.completed).not.toHaveBeenCalled();
    expect(r.authority.hasPendingOperations).toBe(false);
  },
);
it("coverage interruption is sticky while preserving partial native facts", () => {
  const r = completionRig();
  r.authority.acknowledge(r.permit, r.connection, ack);
  r.authority.ingest(r.command("paste-buffer", "9", 1));
  r.authority.invalidateCompletionProof();
  expect(r.authority.ingest(r.command("send-keys", "10", 3))[0]!.disposition).toBe("authored");
  expect(r.completed).not.toHaveBeenCalled();
});
it("wrong command order, foreign wrappers and expired plans do not complete", () => {
  const reversed = completionRig();
  reversed.authority.acknowledge(reversed.permit, reversed.connection, ack);
  reversed.authority.ingestBatch([
    reversed.command("send-keys", "10", 1),
    reversed.command("paste-buffer", "9", 3),
  ]);
  expect(reversed.completed).not.toHaveBeenCalled();
  const r = completionRig();
  r.authority.acknowledge(r.permit, r.connection, { ...ack, wrapperCommandId: "99" });
  r.authority.ingestBatch([r.command("paste-buffer", "9", 1), r.command("send-keys", "10", 3)]);
  expect(r.completed).not.toHaveBeenCalled();
  r.tick(100);
  r.authority.expire();
  r.authority.acknowledge(r.permit, r.connection, ack);
  expect(r.completed).not.toHaveBeenCalled();
});

it.each([true, false])(
  "one-shot capture retains only exact closed-helper proof (beforeAck=%s)",
  (beforeAck) => {
    const completed = vi.fn();
    const a = new OwnedNativeInteractionBindings({
      environmentId,
      serverScope,
      serverEpoch,
      onPlanComplete: completed,
    });
    const permit = a.admitOneShotViewerCapture({ operationId, target })!;
    expect(permit).not.toBeNull();
    expect(
      a.admit({
        operationId: id(20),
        role: "viewer",
        target,
        commands: ["capture-pane"],
        source: null,
      }),
    ).toBeNull();
    const item = projection({}, true, true);
    if (beforeAck) expect(a.ingest(item)).toEqual([]);
    const acked = a.acknowledgeOneShotViewerCapture(permit, identity, ack);
    expect(acked.acknowledged).toBe(true);
    const result = beforeAck ? acked.decisions : a.ingest(item);
    expect(result).toHaveLength(1);
    expect(result[0]!.disposition).toBe("viewer");
    expect(result[0]!.evidence.endpoints.source).toBeNull();
    expect(completed).not.toHaveBeenCalled();
    expect(a.size).toMatchObject({ connections: 0, permits: 0, pending: 0 });
    expect(a.acknowledgeOneShotViewerCapture(permit, identity, ack).acknowledged).toBe(false);
  },
);
it("one-shot capture rejects copied permits, forged identity and input plans and expires bounded proof", () => {
  let now = 0;
  const a = new OwnedNativeInteractionBindings({
    environmentId,
    serverScope,
    serverEpoch,
    now: () => now,
    maxPermits: 1,
    permitMs: 100,
  });
  const permit = a.admitOneShotViewerCapture({ operationId, target })!;
  expect(a.admitOneShotViewerCapture({ operationId: id(30), target })).toBeNull();
  expect(() =>
    a.admitOneShotViewerCapture({ operationId, target, commands: ["send-keys"] } as never),
  ).toThrow();
  expect(a.acknowledgeOneShotViewerCapture({ ...permit }, identity, ack).acknowledged).toBe(false);
  expect(
    a.acknowledgeOneShotViewerCapture(permit, { ...identity, connectionId: "9" }, ack).acknowledged,
  ).toBe(false);
  expect(
    a.acknowledgeOneShotViewerCapture(permit, identity, { ...ack, serverEpoch: id(99) })
      .acknowledged,
  ).toBe(false);
  expect(a.ingest(projection())[0]!.disposition).toBe("unknown");
  expect(a.acknowledgeOneShotViewerCapture(permit, identity, ack).acknowledged).toBe(true);
  now = 101;
  a.expire();
  expect(a.size).toMatchObject({ connections: 0, permits: 0, pending: 0 });
  expect(a.ingest(projection({}, true, true))[0]!.disposition).toBe("unknown");
});
