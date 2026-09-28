import { InteractionEvidenceRecordSchemaZ } from "@tmux-ide/contracts";
import { interactionForCurrentPane } from "../ui/pane-interaction-presentation.ts";
import { createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { InteractionReceiptSchemaZ, type TmuxInteractionCursor } from "@tmux-ide/contracts";
import { interactionPaneEndpointKey } from "@tmux-ide/core";
import type { TmuxInteractionSubscriptionOptions } from "@tmux-ide/daemon-client/tmux-server-interaction-events";
import {
  createApplicationPaneActivityOwner,
  type ApplicationInteractionSource,
} from "./application-pane-activity-owner.ts";
const uuid = "00000000-0000-4000-8000-000000000001";
const source = (index = 0): ApplicationInteractionSource => ({
  environmentId: uuid,
  server: { serverId: `tmux-server.${String(index).repeat(32)}`, generation: uuid },
  baseUrl: "http://localhost",
  ownerToken: "private",
});
const endpoint = (input: ApplicationInteractionSource) => ({
  kind: "pane" as const,
  environmentId: input.environmentId,
  serverScope: input.server,
  workspaceName: "workspace.alpha",
  semanticPaneId: "pane.alpha",
  paneLifetimeId: uuid,
});
function receipt(scope: ApplicationInteractionSource, sequence: number) {
  const operationId = `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  const at = new Date().toISOString();
  return InteractionReceiptSchemaZ.parse({
    type: "interaction.receipt",
    sequence,
    operationId,
    origin: "sdk",
    workspaceName: "workspace.alpha",
    sourceSemanticPaneId: null,
    target: { kind: "pane", semanticPaneId: "pane.alpha" },
    operationKind: "workspace.pane.read",
    summary: { operationKind: "workspace.pane.read", observedOnly: true },
    proof: null,
    at,
    resourceRevision: null,
    phase: "accepted",
    evidence: {
      schemaVersion: 1,
      interactionId: operationId,
      revision: 0,
      endpoints: { source: null, destination: endpoint(scope) },
      actor: { kind: "unknown", reason: "unbound-source" },
      observation: { kind: "admission", operationId },
      effect: { kind: "unknown" },
      occurredAt: null,
      receivedAt: at,
      timeBasis: "unknown",
    },
  });
}
function rig(initial = [source()]) {
  const calls: {
    options: TmuxInteractionSubscriptionOptions;
    close: ReturnType<typeof vi.fn>;
    fail(error: Error): void;
    emit(sequences: number[], gap?: boolean): void;
  }[] = [];
  let dispose!: () => void;
  const value = createRoot((cleanup) => {
    dispose = cleanup;
    const [sources, setSources] = createSignal(initial);
    const activity = createApplicationPaneActivityOwner(sources, (options) => {
      let fail!: (error: Error) => void;
      let finish!: () => void;
      const done = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      let cursor: TmuxInteractionCursor = options.resume ?? { server: options.server, cursor: 0 };
      const close = vi.fn(finish);
      calls.push({
        options,
        close,
        fail,
        emit(sequences, gap = false) {
          const selected =
            initial.find((item) => item.server.serverId === options.server.serverId) ?? source();
          void options.onBatch(
            {
              version: 1,
              type: "batch",
              server: options.server,
              after: cursor.cursor,
              cursor: sequences.at(-1)!,
              gap: gap ? { from: cursor.cursor + 1, through: sequences[0]! - 1 } : null,
              receipts: sequences.map((sequence) => receipt(selected, sequence)),
            },
            new AbortController().signal,
          );
          cursor = { server: options.server, cursor: sequences.at(-1)! };
        },
      });
      return {
        ready: Promise.resolve(),
        done,
        close,
        getObservationStatus: () => null,
        getCursor: () => cursor,
      };
    });
    return { activity, setSources };
  });
  return { ...value, calls, dispose };
}
afterEach(() => vi.useRealTimers());
it("consumes every receipt in a burst and expires transient presence without losing bounded history", async () => {
  vi.useFakeTimers();
  const f = rig();
  await Promise.resolve();
  try {
    f.calls[0]!.emit(Array.from({ length: 64 }, (_, index) => index + 1));
    expect(f.activity.activity()).toHaveLength(64);
    expect(f.activity().has(interactionPaneEndpointKey(endpoint(source())))).toBe(true);
    await vi.advanceTimersByTimeAsync(3201);
    expect(f.activity().size).toBe(0);
    expect(f.activity.activity()).toHaveLength(64);
  } finally {
    f.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
  expect(f.calls[0]!.close).toHaveBeenCalledOnce();
});
it("keeps equal sequence and operation IDs from two owners independent and retires one scope only", async () => {
  const sources = [source(), source(1)];
  const f = rig(sources);
  await Promise.resolve();
  try {
    f.calls[0]!.emit([1]);
    f.calls[1]!.emit([1]);
    expect(f.activity.activity()).toHaveLength(2);
    expect(f.activity().size).toBe(2);
    f.setSources([sources[1]!]);
    await Promise.resolve();
    expect(f.activity.activity()).toHaveLength(1);
    expect(f.activity().has(interactionPaneEndpointKey(endpoint(source(1))))).toBe(true);
    expect(f.calls[0]!.close).toHaveBeenCalledOnce();
    expect(f.calls[1]!.close).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});
it("reconnects with the exact acknowledged owner cursor and clears pre-gap transient evidence", async () => {
  vi.useFakeTimers();
  const f = rig();
  await Promise.resolve();
  try {
    f.calls[0]!.emit([1]);
    f.calls[0]!.fail(new Error("disconnected"));
    await vi.advanceTimersByTimeAsync(250);
    expect(f.calls[1]!.options.resume).toEqual({ server: source().server, cursor: 1 });
    f.calls[1]!.emit([4], true);
    expect(f.activity.activity().map((event) => event.sequence)).toEqual([4]);
  } finally {
    f.dispose();
  }
  expect(vi.getTimerCount()).toBe(0);
});
it("drops late batches after removal and never subscribes to legacy client operations", async () => {
  const f = rig();
  await Promise.resolve();
  f.setSources([]);
  await Promise.resolve();
  f.calls[0]!.emit([1]);
  expect(f.activity.activity()).toEqual([]);
  f.dispose();
});

it("keeps coverage scoped, updates it while idle and clears disconnected ownership", async () => {
  const a = source(),
    b = source(1);
  const r = rig([a, b]);
  const status = {
    schemaVersion: 1 as const,
    environmentId: a.environmentId,
    serverScope: a.server,
    method: "stock-hooks" as const,
    capabilityVersion: 1,
    commands: ["send-keys" as const, "capture-pane" as const],
    effects: [],
    coverage: "partial" as const,
    cursor: null,
    lastGap: null,
    droppedCount: "0",
  };
  r.calls[0]!.options.onStatus!(status);
  expect(r.activity.observationStatus(endpoint(a))).toEqual(status);
  expect(r.activity.observationStatus(endpoint(b))).toBeNull();
  expect(() => r.calls[1]!.options.onStatus!(status)).toThrow("Foreign observation status");
  r.calls[0]!.emit([3], true);
  expect(r.activity.observationStatus(endpoint(a))).toEqual(status);
  r.calls[0]!.fail(new Error("disconnect"));
  await Promise.resolve();
  expect(r.activity.observationStatus(endpoint(a))).toBeNull();
  r.dispose();
});

it("joins physical activity only through current birth metadata and expires aliases without losing provenance", async () => {
  vi.useFakeTimers();
  const scope = source(),
    r = rig([scope]);
  const alias = endpoint(scope),
    nativeIdentity = { serverEpoch: uuid, paneBirthId: "7" };
  const physical = {
    kind: "native-pane" as const,
    environmentId: uuid,
    serverScope: scope.server,
    ...nativeIdentity,
  };
  const entry = InteractionEvidenceRecordSchemaZ.parse({
    type: "interaction.evidence",
    sequence: 1,
    evidence: {
      schemaVersion: 1,
      interactionId: uuid,
      revision: 0,
      endpoints: { source: null, destination: physical },
      actor: { kind: "unknown", reason: "unavailable" },
      observation: {
        kind: "native-journal",
        serverEpoch: uuid,
        command: "send-keys",
        cursor: { epoch: uuid, sequence: "1" },
        commandId: null,
        parentCommandId: null,
        correlatedOperationId: null,
      },
      effect: { kind: "input-enqueued" },
      occurredAt: null,
      timeBasis: "unknown",
      receivedAt: new Date().toISOString(),
    },
  });
  await r.calls[0]!.options.onBatch(
    {
      version: 1,
      type: "batch",
      server: scope.server,
      after: 0,
      cursor: 1,
      gap: null,
      receipts: [entry],
    },
    new AbortController().signal,
  );
  for (const current of [
    alias,
    { ...alias, workspaceName: "linked", semanticPaneId: "pane.linked" },
  ]) {
    const found = interactionForCurrentPane(r.activity(), current, nativeIdentity);
    expect(found?.destinationEndpoint).toEqual(physical);
    expect(found?.displayDestinationEndpoint).toEqual(current);
  }
  expect(interactionForCurrentPane(r.activity(), alias)).toBeUndefined();
  expect(
    interactionForCurrentPane(r.activity(), alias, { ...nativeIdentity, paneBirthId: "8" }),
  ).toBeUndefined();
  expect(
    interactionForCurrentPane(
      r.activity(),
      { ...alias, environmentId: "00000000-0000-4000-8000-000000000002" },
      nativeIdentity,
    ),
  ).toBeUndefined();
  await vi.advanceTimersByTimeAsync(3201);
  expect(interactionForCurrentPane(r.activity(), alias, nativeIdentity)).toBeUndefined();
  expect(r.activity.activity()[0]!.evidence?.endpoints.destination).toEqual(physical);
  r.dispose();
});

it("keeps verified viewer operations out of Home activity and pane badges", async () => {
  const scope = source(),
    r = rig([scope]);
  try {
    const base = receipt(scope, 1).evidence!;
    const entry = InteractionEvidenceRecordSchemaZ.parse({
      type: "interaction.evidence",
      sequence: 1,
      evidence: {
        ...base,
        actor: {
          kind: "native",
          issuerId: uuid,
          identity: "connection",
          sourceBindingId: null,
          classification: { kind: "viewer", bindingId: uuid },
        },
        observation: {
          kind: "native-journal",
          serverEpoch: uuid,
          command: "capture-pane",
          cursor: { epoch: uuid, sequence: "1" },
          commandId: uuid,
          parentCommandId: uuid,
          correlatedOperationId: null,
        },
        effect: { kind: "snapshot-produced" },
      },
    });
    await r.calls[0]!.options.onBatch(
      {
        version: 1,
        type: "batch",
        server: scope.server,
        after: 0,
        cursor: 1,
        gap: null,
        receipts: [entry],
      },
      new AbortController().signal,
    );
    expect(r.activity.activity()).toEqual([]);
    expect(interactionForCurrentPane(r.activity(), endpoint(scope))).toBeUndefined();
  } finally {
    r.dispose();
  }
});

it("selects current authenticated machine scopes and ignores foreign or unavailable inventory", async () => {
  const { applicationPaneActivitySources } = await import("./application-pane-activity-owner.ts");
  const first = endpoint(source(1));
  const second = endpoint(source(2));
  const foreign = { ...second, environmentId: "00000000-0000-4000-8000-000000000099" };
  const daemon = { bindHostname: "127.0.0.1", port: 4321, authToken: "owner-secret" };
  const groups = [
    {
      id: "local",
      state: "ready",
      environmentId: uuid,
      agents: [{ interactionEndpoint: first }, { interactionEndpoint: foreign }],
    },
    {
      id: "offline",
      state: "unavailable",
      environmentId: uuid,
      agents: [{ interactionEndpoint: second }],
    },
    {
      id: "unauthenticated",
      state: "ready",
      environmentId: uuid,
      agents: [{ interactionEndpoint: second }],
    },
  ];
  const result = applicationPaneActivitySources(
    groups,
    "local",
    [{ interactionEndpoint: second }, { interactionEndpoint: first }],
    (machine) => (machine === "unauthenticated" ? { ...daemon, authToken: null } : daemon),
  );
  expect(result).toEqual(
    [1, 2].map((index) => ({
      ...source(index),
      baseUrl: "http://127.0.0.1:4321",
      ownerToken: "owner-secret",
    })),
  );
  expect(
    applicationPaneActivitySources(groups, "other", [{ interactionEndpoint: second }], (machine) =>
      machine === "unauthenticated" ? null : daemon,
    ),
  ).toHaveLength(1);
});
