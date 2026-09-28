import {
  InteractionReceiptV1SchemaZ,
  InteractionReceiptV2SchemaZ,
  type InteractionReceipt,
} from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import {
  initialInteractionFeedState,
  interactionPaneEndpointKey,
  interactionForPane,
  interactionPresenceIsFresh,
  interactionReceiptLabel,
  paneInteractionPresence,
  paneInteractionRelationshipLabel,
  reduceInteractionReceipt as reduceReceipt,
} from "./interaction-receipts.ts";

const fixtureId = "00000000-0000-4000-8000-000000000001";
function endpoint(semanticPaneId: string) {
  return {
    kind: "pane" as const,
    environmentId: fixtureId,
    serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: fixtureId },
    paneLifetimeId: fixtureId,
    workspaceName: "workspace.alpha",
    semanticPaneId,
  };
}
// These legacy behavior fixtures explicitly model a verified authored enqueue/snapshot.
// Passive external records instead carry only stock command observation.
function fixtureReceipt(raw: unknown): InteractionReceipt {
  const receipt = InteractionReceiptV1SchemaZ.parse(raw);
  const pane =
    receipt.operationKind === "workspace.pane.send" ||
    receipt.operationKind === "workspace.pane.read";
  const source = receipt.sourceSemanticPaneId ? endpoint(receipt.sourceSemanticPaneId) : null;
  return InteractionReceiptV2SchemaZ.parse({
    ...receipt,
    evidence: pane
      ? {
          schemaVersion: 1,
          interactionId: receipt.operationId,
          revision: receipt.phase === "accepted" ? 0 : 1,
          endpoints: {
            destination: {
              ...endpoint(
                receipt.target.kind === "pane" ? receipt.target.semanticPaneId : "pane.fixture",
              ),
              workspaceName: receipt.workspaceName,
            },
            source,
          },
          actor:
            receipt.origin === "external"
              ? { kind: "unknown", reason: "stock-hook" }
              : source
                ? { kind: "cooperative", bindingId: fixtureId, agentRunId: null }
                : { kind: "unknown", reason: "unbound-source" },
          observation:
            receipt.origin === "external"
              ? {
                  kind: "stock-hook",
                  command:
                    receipt.operationKind === "workspace.pane.read" ? "capture-pane" : "send-keys",
                }
              : receipt.phase === "observed"
                ? {
                    kind: "cooperative-completion",
                    operationId: receipt.operationId,
                    verification:
                      receipt.operationKind === "workspace.pane.read"
                        ? "daemon-snapshot"
                        : "daemon-input-enqueue",
                  }
                : { kind: "admission", operationId: receipt.operationId },
          effect:
            receipt.origin !== "external" && receipt.phase === "observed"
              ? {
                  kind:
                    receipt.operationKind === "workspace.pane.read"
                      ? "snapshot-produced"
                      : "input-enqueued",
                }
              : { kind: "unknown" },
          occurredAt: null,
          timeBasis: "unknown",
          receivedAt: receipt.at,
        }
      : null,
  });
}
function reduceFixtureReceipt(previous: Parameters<typeof reduceReceipt>[0], raw: unknown) {
  return reduceReceipt(previous, fixtureReceipt(raw));
}
function fixtureReceiptLabel(raw: unknown) {
  return interactionReceiptLabel(fixtureReceipt(raw));
}

const base = {
  type: "interaction.receipt" as const,
  operationId: "10000000-0000-4000-8000-000000000001",
  origin: "sdk" as const,
  workspaceName: "workspace.alpha",
  sourceSemanticPaneId: null,
  target: { kind: "pane" as const, semanticPaneId: "pane.alpha" },
  operationKind: "workspace.pane.send" as const,
  summary: {
    operationKind: "workspace.pane.send" as const,
    characterCount: 84,
    byteCount: 84,
    submitted: true,
  },
  proof: null,
  at: "2026-08-10T10:00:00.000Z",
  resourceRevision: null,
};

describe("interaction receipt reducer", () => {
  it("keeps replay history without reviving stale visual presence", () => {
    const now = Date.parse("2026-08-10T10:00:04.000Z");
    expect(interactionPresenceIsFresh({ at: "2026-08-10T10:00:02.000Z" }, now)).toBe(true);
    expect(interactionPresenceIsFresh({ at: "2026-08-10T09:59:59.000Z" }, now)).toBe(false);
    expect(interactionPresenceIsFresh({ at: "not-a-date" }, now)).toBe(false);
  });
  it("advances one operation in place and projects pane feedback", () => {
    const accepted = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "accepted",
    });
    const observed = reduceFixtureReceipt(accepted, {
      ...base,
      sequence: 2,
      phase: "observed",
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });

    expect(observed.activity).toHaveLength(1);
    expect(observed.activity[0]?.phase).toBe("observed");
    expect(interactionForPane(observed, endpoint("pane.alpha"))).toMatchObject({
      phase: "observed",
      label: "sdk observed · delivered 84 characters + Enter",
    });
  });

  it("ignores duplicate replay frames", () => {
    const current = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 3,
      phase: "observed",
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });
    expect(
      reduceFixtureReceipt(current, {
        ...base,
        sequence: 3,
        phase: "observed",
        proof: {
          operationKind: "workspace.pane.send",
          observed: true,
          semanticPaneId: "pane.alpha",
        },
      }),
    ).toBe(current);
  });

  it("never derives activity copy from literal input", () => {
    const state = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "observed",
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });
    expect(JSON.stringify(state)).not.toContain("prompt");
    expect(JSON.stringify(state)).toContain("84 characters");
  });

  it("projects metadata-only external observation without invented counts", () => {
    const state = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      origin: "external",
      phase: "observed",
      summary: { operationKind: "workspace.pane.send", observedOnly: true },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });
    expect(interactionForPane(state, endpoint("pane.alpha"))?.label).toBe(
      "external observed · input command observed",
    );
    expect(JSON.stringify(state)).not.toMatch(/characterCount|byteCount|submitted/u);
  });

  it("projects one authenticated pane relationship onto both endpoints", () => {
    const state = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "observed",
      sourceSemanticPaneId: "pane.editor",
      target: { kind: "pane", semanticPaneId: "pane.tests" },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.tests",
      },
    });

    expect(interactionForPane(state, endpoint("pane.editor"))).toMatchObject({
      direction: "outgoing",
      sourcePaneId: "pane.editor",
      destinationPaneId: "pane.tests",
    });
    expect(interactionForPane(state, endpoint("pane.tests"))).toMatchObject({
      direction: "incoming",
      sourcePaneId: "pane.editor",
      destinationPaneId: "pane.tests",
    });
    expect(
      paneInteractionRelationshipLabel(
        interactionForPane(state, endpoint("pane.tests"))!,
        (endpoint) =>
          ({ "pane.editor": "Editor", "pane.tests": "Tests" })[endpoint.semanticPaneId] ??
          endpoint.semanticPaneId,
      ),
    ).toBe("Editor → Tests");
  });

  it("labels raw tmux traffic as external without inventing a source", () => {
    expect(
      paneInteractionRelationshipLabel({
        origin: "external",
        sourceEndpoint: null,
        destinationEndpoint: endpoint("pane.tests"),
      }),
    ).toBe("External input → pane.tests");
  });

  it("projects pane reads without retaining captured terminal content", () => {
    const state = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      origin: "external",
      operationKind: "workspace.pane.read",
      phase: "observed",
      summary: { operationKind: "workspace.pane.read", observedOnly: true },
      proof: {
        operationKind: "workspace.pane.read",
        observed: true,
        semanticPaneId: "pane.tests",
      },
      target: { kind: "pane", semanticPaneId: "pane.tests" },
    });
    const interaction = interactionForPane(state, endpoint("pane.tests"))!;
    expect(interaction).toMatchObject({
      operationKind: "workspace.pane.read",
      direction: "incoming",
      sourcePaneId: null,
    });
    expect(paneInteractionRelationshipLabel(interaction, () => "Tests")).toBe(
      "External reader reads Tests",
    );
    expect(JSON.stringify(state)).not.toContain("content");
  });

  it("keeps observation, transfer, and focus as separate semantics", () => {
    const read = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      operationKind: "workspace.pane.read",
      phase: "observed",
      summary: { operationKind: "workspace.pane.read", observedOnly: true },
      proof: {
        operationKind: "workspace.pane.read",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });
    expect(paneInteractionPresence(interactionForPane(read, endpoint("pane.alpha"))!)).toEqual({
      role: "read-target",
      kind: "read",
      endpoint: "target",
      treatment: "observation",
      tone: "info",
      badge: "READ",
    });

    const send = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "observed",
      sourceSemanticPaneId: "pane.editor",
      target: { kind: "pane", semanticPaneId: "pane.tests" },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.tests",
      },
    });
    expect(
      paneInteractionPresence(interactionForPane(send, endpoint("pane.editor"))!),
    ).toMatchObject({
      role: "send-source",
      treatment: "transfer",
      badge: "SENT",
    });
    expect(
      paneInteractionPresence(interactionForPane(send, endpoint("pane.tests"))!),
    ).toMatchObject({
      role: "send-target",
      badge: "RECEIVED",
    });
    expect(
      paneInteractionPresence(interactionForPane(send, endpoint("pane.tests"))!),
    ).not.toHaveProperty("focused");
  });

  it("keeps structural receipts in Activity without inventing pane communication", () => {
    const state = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      operationKind: "workspace.pane.resize",
      target: { kind: "pane", semanticPaneId: "pane.tests" },
      phase: "observed",
      summary: { operationKind: "workspace.pane.resize", axis: "cols", cells: 120 },
      proof: {
        operationKind: "workspace.pane.resize",
        outcome: "applied",
        semanticPaneId: "pane.tests",
        axis: "cols",
        cells: 118,
      },
    });

    expect(state.activity[0]).toMatchObject({
      operationKind: "workspace.pane.resize",
      target: { kind: "pane", semanticPaneId: "pane.tests" },
    });
    expect(state.activity[0]?.summary).not.toHaveProperty("text");
    expect(state.panes).toEqual({});
  });

  it("uses request-neutral copy until a mutation is actually observed", () => {
    const closePane = {
      ...base,
      operationKind: "workspace.pane.kill" as const,
      summary: { operationKind: "workspace.pane.kill" as const },
    };
    expect(fixtureReceiptLabel({ ...closePane, sequence: 1, phase: "accepted" })).toBe(
      "sdk accepted · close pane",
    );
    expect(fixtureReceiptLabel({ ...closePane, sequence: 2, phase: "rejected" })).toBe(
      "sdk rejected · close pane",
    );
    expect(fixtureReceiptLabel({ ...closePane, sequence: 3, phase: "timed-out" })).toBe(
      "sdk timed out · close pane",
    );
    expect(
      fixtureReceiptLabel({
        ...closePane,
        sequence: 4,
        phase: "observed",
        proof: {
          operationKind: "workspace.pane.kill",
          outcome: "applied",
          semanticPaneId: "pane.alpha",
          windowClosed: false,
          remainingWindowCount: 2,
        },
      }),
    ).toBe("sdk observed · pane closed");

    expect(fixtureReceiptLabel({ ...base, sequence: 5, phase: "accepted" })).toContain(
      "send 84 characters",
    );
    expect(fixtureReceiptLabel({ ...base, sequence: 6, phase: "rejected" })).not.toMatch(
      /delivered|received/u,
    );
  });

  it("enforces immutable operation identity and one-way lifecycle transitions", () => {
    const accepted = reduceFixtureReceipt(initialInteractionFeedState(), {
      ...base,
      sequence: 1,
      phase: "accepted",
    });
    const withStaleProjection = {
      ...accepted,
      panes: Object.freeze({
        ...accepted.panes,
        "pane.stale": {
          ...accepted.panes[interactionPaneEndpointKey(endpoint("pane.alpha"))]!,
          paneId: "pane.stale",
        },
      }),
    };
    const observed = reduceFixtureReceipt(withStaleProjection, {
      ...base,
      sequence: 2,
      phase: "observed",
      sourceSemanticPaneId: "pane.editor",
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.alpha",
      },
    });
    expect(observed.activity[0]?.phase).toBe("observed");
    expect(observed.panes).not.toHaveProperty("pane.stale");
    expect(interactionForPane(observed, endpoint("pane.editor"))).not.toBeNull();

    const regressed = reduceFixtureReceipt(observed, {
      ...base,
      sequence: 3,
      phase: "accepted",
    });
    expect(regressed.sequence).toBe(3);
    expect(regressed.activity[0]?.phase).toBe("observed");
    expect(regressed.panes[interactionPaneEndpointKey(endpoint("pane.alpha"))]?.sequence).toBe(2);

    const mutated = reduceFixtureReceipt(regressed, {
      ...base,
      sequence: 4,
      phase: "observed",
      target: { kind: "pane", semanticPaneId: "pane.other" },
      proof: {
        operationKind: "workspace.pane.send",
        observed: true,
        semanticPaneId: "pane.other",
      },
    });
    expect(mutated.sequence).toBe(4);
    expect(mutated.activity[0]?.target).toEqual({
      kind: "pane",
      semanticPaneId: "pane.alpha",
    });
    expect(mutated.panes).not.toHaveProperty("pane.other");
  });
});

describe("scoped receipt evidence", () => {
  it("keeps colliding server cursors, operation IDs and semantic IDs independent", () => {
    const a = fixtureReceipt({ ...base, sequence: 10, phase: "accepted" });
    const b = structuredClone(a);
    b.sequence = 1;
    b.evidence!.endpoints.destination.serverScope.serverId = `tmux-server.${"b".repeat(32)}`;
    const state = reduceReceipt(reduceReceipt(initialInteractionFeedState(), a), b);
    expect(state.activity).toHaveLength(2);
    expect(Object.keys(state.panes)).toHaveLength(2);
    expect(interactionForPane(state, endpoint("pane.alpha"))?.sequence).toBe(10);
    expect(
      interactionForPane(state, {
        ...endpoint("pane.alpha"),
        paneLifetimeId: "00000000-0000-4000-8000-000000000009",
      }),
    ).toBeNull();
  });
  it("keeps stock observation neutral and rejects same-phase evidence downgrade", () => {
    const raw = {
      ...base,
      origin: "external",
      sequence: 1,
      phase: "observed",
      summary: { operationKind: "workspace.pane.send", observedOnly: true },
      proof: { operationKind: "workspace.pane.send", observed: true, semanticPaneId: "pane.alpha" },
    };
    const stock = fixtureReceipt(raw);
    const state = reduceReceipt(initialInteractionFeedState(), stock);
    expect(
      paneInteractionPresence(interactionForPane(state, endpoint("pane.alpha"))!),
    ).toMatchObject({ badge: "INPUT OBSERVED" });
    const forged = structuredClone(stock);
    forged.sequence = 2;
    forged.evidence!.revision = 2;
    forged.evidence!.endpoints.destination = {
      ...endpoint("pane.alpha"),
      paneLifetimeId: "00000000-0000-4000-8000-000000000009",
    };
    expect(reduceReceipt(state, forged).activity).toEqual(state.activity);
  });
});
