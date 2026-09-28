import { expect, it } from "vitest";
import type { NativeJournalRecord } from "@tmux-ide/contracts";
import { NativeInteractionProjector } from "./native-interaction-projector.ts";
import { OwnedNativeInteractionBindings } from "./owned-native-interaction-bindings.ts";
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
function projection(extra: Partial<NativeJournalRecord> = {}, effect = true) {
  const record = (sequence: string, kind: number): NativeJournalRecord => ({
    sequence,
    kind,
    commandId: "9",
    issuerId: "7",
    requestId: "5",
    parentCommandId: "8",
    monotonicUs: "100",
    count: kind === 5 ? "3" : "0",
    targetId: 0,
    targetBirthId: "1",
    outcome: 1,
    flags: 1,
    transport: 1,
    derivation: 1,
    correlation: operationId,
    ...extra,
  });
  const records = effect ? [record("1", 5), record("2", 1)] : [record("1", 1)];
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
  expect(authority.nextExpiryAt).toBe(10);
  now = 10;
  authority.expire();
  expect(authority.size.connections).toBe(0);
  expect(
    authority.registerConnection({ ...identity, connectionId: "8" }, "authored"),
  ).not.toBeNull();
  expect(authority.ingest(projection())[0]!.disposition).toBe("unknown");
});
