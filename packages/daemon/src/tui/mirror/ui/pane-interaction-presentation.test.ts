import { expect, it } from "vitest";
import {
  paneInteractionPresentation,
  paneInteractionIsHeaderWorthy,
  interactionCoveragePresentation,
  type PaneInteractionEvent,
} from "./pane-interaction-presentation.ts";
const endpoint = (semanticPaneId: string) => ({
  kind: "pane" as const,
  environmentId: "00000000-0000-4000-8000-000000000001",
  serverScope: {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "00000000-0000-4000-8000-000000000001",
  },
  workspaceName: "test",
  paneLifetimeId: "00000000-0000-4000-8000-000000000002",
  semanticPaneId,
});
const event: PaneInteractionEvent = {
  operationId: "read",
  operationKind: "workspace.pane.read",
  phase: "accepted",
  origin: "tui",
  sourcePaneId: "source",
  destinationPaneId: "target",
  sourceEndpoint: endpoint("source"),
  destinationEndpoint: endpoint("target"),
  effect: { kind: "snapshot-produced" },
  at: "2026-09-28T00:00:00Z",
};
const name = (value: ReturnType<typeof endpoint>) =>
  ({ source: "Codex", target: "Tests" })[value.semanticPaneId];
it("never names a request's unverified source", () => {
  const value = paneInteractionPresentation(event, name);
  expect(value.label).toBe("Read requested");
  expect(value.source).toBe("Not yet verified");
});
it("distinguishes the two endpoints of an observed read", () => {
  expect(paneInteractionPresentation({ ...event, phase: "observed" }, name).label).toBe(
    "Read by Codex",
  );
  expect(
    paneInteractionPresentation({ ...event, phase: "observed", direction: "outgoing" }, name).label,
  ).toBe("Read Tests");
});
it("never invents an actor for external reads or sends", () => {
  expect(
    paneInteractionPresentation(
      {
        ...event,
        phase: "observed",
        sourcePaneId: null,
        sourceEndpoint: null,
        effect: { kind: "unknown" },
        origin: "external",
      },
      name,
    ).source,
  ).toBe("Unknown");
  expect(
    paneInteractionPresentation(
      {
        ...event,
        phase: "observed",
        sourcePaneId: null,
        sourceEndpoint: null,
        effect: { kind: "unknown" },
        origin: "external",
        operationKind: "workspace.pane.send",
      },
      name,
    ).label,
  ).toBe("Send command · sender unknown");
});
it("keeps stock-hook command evidence distinct from delivery and reader attribution", () => {
  for (const operationKind of ["workspace.pane.read", "workspace.pane.send"] as const) {
    const value = paneInteractionPresentation(
      {
        ...event,
        phase: "observed",
        sourceEndpoint: null,
        effect: { kind: "unknown" },
        origin: "external",
        operationKind,
      },
      name,
    );
    expect(value.source).toBe("Unknown");
    expect(value.phase).toBe("Command observed");
    expect(value.commandOnly).toBe(true);
    expect(value.label).not.toContain("Codex");
    expect(value.explanation).toContain(
      operationKind === "workspace.pane.read" ? "does not prove" : "not confirmed",
    );
  }
});
it("distinguishes timeouts from rejection and delivery from understanding", () => {
  expect(paneInteractionPresentation({ ...event, phase: "timed-out" }, name).label).toBe(
    "Read timed out",
  );
  expect(paneInteractionPresentation({ ...event, phase: "rejected" }, name).source).toBe("Unknown");
  expect(
    paneInteractionPresentation(
      { ...event, phase: "observed", operationKind: "workspace.pane.send" },
      name,
    ).explanation,
  ).toContain("does not mean the application processed");
});

it("separates current observation coverage from event claims", () => {
  expect(interactionCoveragePresentation(null).label).toBe("Observation unavailable");
  const status = {
    schemaVersion: 1 as const,
    environmentId: endpoint("target").environmentId,
    serverScope: endpoint("target").serverScope,
    method: "stock-hooks" as const,
    capabilityVersion: 1,
    commands: ["send-keys" as const],
    effects: [],
    coverage: "partial" as const,
    cursor: null,
    lastGap: { reason: "retention-overflow" as const, at: new Date().toISOString(), range: null },
    droppedCount: null,
  };
  expect(interactionCoveragePresentation(status)).toMatchObject({
    label: "Partial · tmux hooks",
    gap: "Some activity may be missing.",
  });
  expect(interactionCoveragePresentation(status).detail).toContain("not confirmed");
  expect(
    interactionCoveragePresentation({
      ...status,
      method: "native-journal",
      coverage: "declared-capabilities",
      effects: ["input-enqueued"],
    }).detail,
  ).toContain("does not identify its caller");
});

it("reserves chrome for completed attributed cross-pane effects", () => {
  const completed = { ...event, phase: "observed" as const, origin: "cli" as const };
  expect(paneInteractionIsHeaderWorthy(completed)).toBe(true);
  expect(paneInteractionIsHeaderWorthy(event)).toBe(false);
  expect(paneInteractionIsHeaderWorthy({ ...completed, sourceEndpoint: null })).toBe(false);
  expect(
    paneInteractionIsHeaderWorthy({
      ...completed,
      origin: "external",
      effect: { kind: "unknown" },
    }),
  ).toBe(false);
  expect(paneInteractionIsHeaderWorthy({ ...completed, origin: "tui" })).toBe(false);
  expect(
    paneInteractionIsHeaderWorthy({
      ...completed,
      sourceEndpoint: completed.destinationEndpoint as typeof completed.sourceEndpoint,
    }),
  ).toBe(false);
});

it("names an authored send without claiming application delivery", () => {
  const send = {
    ...event,
    phase: "observed" as const,
    origin: "cli" as const,
    operationKind: "workspace.pane.send" as const,
    effect: { kind: "unknown" as const },
  };
  expect(paneInteractionIsHeaderWorthy(send)).toBe(true);
  const value = paneInteractionPresentation(send, name);
  expect(value.label).toBe("Send command from Codex");
  expect(value.explanation).toContain("not confirmed");
});
