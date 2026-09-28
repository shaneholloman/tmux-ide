import { describe, expect, it } from "vitest";
import {
  InteractionEvidenceSchemaZ,
  InteractionObservationGapSchemaZ,
  InteractionObservationStatusSchemaZ,
  NativeInteractionSequenceSchemaZ,
} from "../interaction-evidence.ts";

const id = "00000000-0000-4000-8000-000000000001";
const endpoint = {
  kind: "pane",
  environmentId: id,
  serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: id },
  paneLifetimeId: id,
  workspaceName: "workspace.project",
  semanticPaneId: "pane.editor",
};
const stock = {
  schemaVersion: 1,
  interactionId: id,
  revision: 0,
  endpoints: { destination: endpoint, source: null },
  actor: { kind: "unknown", reason: "stock-hook" },
  observation: { kind: "stock-hook", command: "send-keys" },
  effect: { kind: "unknown" },
  occurredAt: null,
  timeBasis: "unknown",
  receivedAt: "2026-09-28T10:00:00Z",
};
const native = {
  ...stock,
  actor: {
    kind: "native",
    issuerId: id,
    identity: "connection",
    sourceBindingId: null,
    classification: { kind: "viewer", bindingId: id },
  },
  observation: {
    kind: "native-journal",
    command: "send-keys",
    commandId: id,
    parentCommandId: null,
    correlatedOperationId: null,
    cursor: { epoch: id, sequence: "9007199254740993" },
  },
  effect: { kind: "input-enqueued" },
};

describe("interaction evidence", () => {
  it("preserves truthful stock and bound native facts through strict round trips", () => {
    for (const value of [stock, native])
      expect(InteractionEvidenceSchemaZ.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
  it("retains unresolved targets without recyclable native ids", () => {
    expect(
      InteractionEvidenceSchemaZ.safeParse({
        ...stock,
        endpoints: {
          source: null,
          destination: {
            kind: "unresolved-pane",
            environmentId: id,
            serverScope: endpoint.serverScope,
            observationRef: id,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      InteractionEvidenceSchemaZ.safeParse({
        ...stock,
        endpoints: { source: null, destination: { ...endpoint, runtimePaneId: "%0" } },
      }).success,
    ).toBe(false);
  });
  it.each(["text", "argv", "pid", "credential", "contentHash"])(
    "rejects unsolicited %s metadata",
    (key) => {
      expect(
        InteractionEvidenceSchemaZ.safeParse({
          ...native,
          actor: { ...native.actor, [key]: "secret" },
        }).success,
      ).toBe(false);
    },
  );
  it("rejects guessed actors, effects, viewer classification and wrong correlation", () => {
    for (const value of [
      { ...stock, effect: { kind: "input-enqueued" } },
      { ...stock, endpoints: { ...stock.endpoints, source: endpoint } },
      { ...native, actor: { ...native.actor, identity: "advertised-process" } },
      { ...native, actor: { ...native.actor, sourceBindingId: id } },
      { ...native, observation: { ...native.observation, command: "capture-pane" } },
      {
        ...native,
        observation: {
          ...native.observation,
          correlatedOperationId: "00000000-0000-4000-8000-000000000002",
        },
      },
      { ...stock, occurredAt: stock.receivedAt },
    ])
      expect(InteractionEvidenceSchemaZ.safeParse(value).success).toBe(false);
  });
  it("requires a resolved bound source for cooperative observations and matching completion evidence", () => {
    const value = {
      ...stock,
      endpoints: { ...stock.endpoints, source: endpoint },
      actor: { kind: "cooperative", bindingId: id, agentRunId: null },
      observation: {
        kind: "cooperative-completion",
        operationId: id,
        verification: "daemon-snapshot",
      },
      effect: { kind: "snapshot-produced" },
    };
    expect(InteractionEvidenceSchemaZ.safeParse(value).success).toBe(true);
    expect(
      InteractionEvidenceSchemaZ.safeParse({ ...value, effect: { kind: "input-enqueued" } })
        .success,
    ).toBe(false);
    expect(
      InteractionEvidenceSchemaZ.safeParse({ ...value, endpoints: stock.endpoints }).success,
    ).toBe(false);
  });
});

describe("observation coverage", () => {
  it.each(["", "-1", "01", "abc", "18446744073709551616", "9".repeat(100)])(
    "rejects unsafe cursor %s without throwing",
    (sequence) => {
      expect(NativeInteractionSequenceSchemaZ.safeParse(sequence).success).toBe(false);
    },
  );
  it("retains uint64 precision and rejects reversed or malformed loss ranges", () => {
    expect(NativeInteractionSequenceSchemaZ.parse("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    const gap = {
      reason: "native-range-dropped",
      at: stock.receivedAt,
      range: { epoch: id, from: "2", to: "1" },
    };
    expect(InteractionObservationGapSchemaZ.safeParse(gap).success).toBe(false);
    expect(
      InteractionObservationGapSchemaZ.safeParse({ ...gap, range: { ...gap.range, from: "bad" } })
        .success,
    ).toBe(false);
    expect(InteractionObservationGapSchemaZ.safeParse({ ...gap, range: null }).success).toBe(true);
  });
  it("does not advertise stock effect proof or complete coverage", () => {
    const value = {
      schemaVersion: 1,
      environmentId: id,
      serverScope: endpoint.serverScope,
      method: "stock-hooks",
      capabilityVersion: 1,
      commands: ["send-keys", "capture-pane"],
      effects: [],
      coverage: "partial",
      cursor: null,
      lastGap: null,
      droppedCount: null,
    };
    expect(InteractionObservationStatusSchemaZ.safeParse(value).success).toBe(true);
    for (const change of [
      { coverage: "declared-capabilities" },
      { effects: ["input-enqueued"] },
      { commands: ["paste-buffer"] },
      { commands: ["send-keys", "send-keys"] },
      { method: "unavailable" },
    ])
      expect(InteractionObservationStatusSchemaZ.safeParse({ ...value, ...change }).success).toBe(
        false,
      );
  });
});
