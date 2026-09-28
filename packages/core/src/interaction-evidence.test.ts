import { describe, expect, it } from "vitest";
import { InteractionEvidenceSchemaZ, type InteractionEvidence } from "@tmux-ide/contracts";
import { canEnrichInteractionEvidence } from "./interaction-evidence.ts";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const stock = InteractionEvidenceSchemaZ.parse({
  schemaVersion: 1,
  interactionId: id,
  revision: 0,
  endpoints: {
    destination: {
      kind: "pane",
      environmentId: id,
      serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: id },
      paneLifetimeId: id,
      workspaceName: "workspace.project",
      semanticPaneId: "pane.editor",
    },
    source: null,
  },
  actor: { kind: "unknown", reason: "stock-hook" },
  observation: { kind: "stock-hook", command: "send-keys" },
  effect: { kind: "unknown" },
  occurredAt: null,
  timeBasis: "unknown",
  receivedAt: "2026-09-28T10:00:00Z",
});
const native = InteractionEvidenceSchemaZ.parse({
  ...stock,
  revision: 1,
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
});

describe("monotonic interaction evidence", () => {
  it("enriches a correlated stock command without changing its immutable endpoint", () => {
    if (native.observation.kind !== "native-journal") throw Error("fixture");
    expect(
      canEnrichInteractionEvidence(stock, {
        ...native,
        observation: {
          ...native.observation,
          correlatedOperationId: stock.interactionId,
        },
      }),
    ).toBe(true);
    expect(canEnrichInteractionEvidence(native, native)).toBe(false);
  });
  it("does not correlate matching command, target and timestamp without explicit native proof", () => {
    expect(canEnrichInteractionEvidence(stock, native)).toBe(false);
  });
  it("rejects endpoint, generation, lifetime, effect, actor and occurrence changes", () => {
    const destination = stock.endpoints.destination;
    const observation = native.observation;
    if (destination.kind !== "pane" || observation.kind !== "native-journal")
      throw Error("fixture");
    const candidates = [
      { interactionId: other },
      { effect: { kind: "unknown" } },
      { actor: stock.actor },
      { occurredAt: native.receivedAt, timeBasis: "daemon" },
      { receivedAt: "2026-09-28T09:00:00Z" },
      ...[
        { paneLifetimeId: other },
        { environmentId: other },
        { serverScope: { ...destination.serverScope, generation: other } },
      ].map((patch) => ({
        endpoints: {
          ...native.endpoints,
          destination: { ...destination, ...patch },
        },
      })),
      ...[
        { commandId: other },
        { cursor: { epoch: other, sequence: "9007199254740994" } },
        { cursor: { epoch: id, sequence: "9007199254740992" } },
      ].map((patch) => ({ observation: { ...observation, ...patch } })),
    ];
    for (const patch of candidates)
      expect(
        canEnrichInteractionEvidence(native, {
          ...native,
          revision: 2,
          ...patch,
        } as InteractionEvidence),
      ).toBe(false);
  });
  it("compares uint64 cursors precisely without Number conversion", () => {
    if (native.observation.kind !== "native-journal") throw Error("fixture");
    expect(
      canEnrichInteractionEvidence(native, {
        ...native,
        revision: 2,
        observation: {
          ...native.observation,
          cursor: { epoch: id, sequence: "9007199254740994" },
        },
      }),
    ).toBe(true);
  });
  it("permits admitted completion but requires an explicit native operation correlation", () => {
    const admitted: InteractionEvidence = {
      ...stock,
      observation: { kind: "admission", operationId: id },
    };
    expect(canEnrichInteractionEvidence(admitted, native)).toBe(false);
    if (native.observation.kind !== "native-journal") throw Error("fixture");
    expect(
      canEnrichInteractionEvidence(admitted, {
        ...native,
        observation: {
          ...native.observation,
          correlatedOperationId: id,
        },
      }),
    ).toBe(true);
  });
});
