/* @jsxImportSource @opentui/solid */
import { expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { MouseButtons } from "@opentui/core/testing";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest, expectFrameBounds } from "../testing/renderer-harness.test.ts";
import { PaneInteraction } from "./pane-interaction.tsx";
import { AgentRow } from "./agent-row.tsx";
import type { PaneInteractionEvent } from "./pane-interaction-presentation.ts";
const endpoint = (semanticPaneId: string) => ({
  kind: "pane" as const,
  environmentId: "00000000-0000-4000-8000-000000000001",
  serverScope: {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "00000000-0000-4000-8000-000000000001",
  },
  workspaceName: "research",
  paneLifetimeId: "00000000-0000-4000-8000-000000000002",
  semanticPaneId,
});
const base: PaneInteractionEvent = {
  operationId: "op",
  operationKind: "workspace.pane.read",
  phase: "accepted",
  origin: "tui",
  sourcePaneId: "source",
  destinationPaneId: "target",
  sourceEndpoint: endpoint("source"),
  destinationEndpoint: endpoint("target"),
  effect: { kind: "snapshot-produced" },
  at: new Date().toISOString(),
};
const name = (value: ReturnType<typeof endpoint>) =>
  value.semanticPaneId === "source" ? "Codex" : "Tests";
it("external command observations do not display a delivery success marker", async () => {
  const setup = await renderForTest(
    () => (
      <PaneInteraction
        theme={createSemanticThemeSnapshot({ mode: "dark" })}
        event={{
          ...base,
          phase: "observed",
          origin: "external",
          sourceEndpoint: null,
          effect: { kind: "unknown" },
          sourcePaneId: null,
          operationKind: "workspace.pane.send",
        }}
        width={70}
      />
    ),
    { width: 70, height: 1 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("· Send command · sender unknown");
  expect(frame).not.toContain("✓");
});
for (const mode of ["light", "dark"] as const)
  it(`${mode}: compact row and full interaction agree, keeping context and click isolation`, async () => {
    const theme = createSemanticThemeSnapshot({ mode });
    let details = 0,
      open = 0;
    const event = { ...base, phase: "observed" as const };
    const setup = await renderForTest(
      () => (
        <box width={70} height={4}>
          <PaneInteraction
            theme={theme}
            event={event}
            paneName={name}
            width={70}
            onDetails={() => details++}
          />
          <AgentRow
            theme={theme}
            id="tests"
            name="Tests"
            context="Local · main"
            activity="running"
            interaction={event}
            paneName={name}
            width={36}
            onOpen={() => open++}
          />
        </box>
      ),
      { width: 70, height: 4 },
    );
    await setup.renderOnce();
    const rows = setup.captureCharFrame().split("\n");
    expect(rows[0]).toContain("Read by Codex");
    expect(rows[1]).toContain("Read by Codex");
    expect(rows[2]).toContain("Local · main");
    await setup.mockMouse.click(rows[0]!.indexOf("Details"), 0, MouseButtons.LEFT);
    expect([details, open]).toEqual([1, 0]);
    expectFrameBounds(setup.captureCharFrame(), 70, 4);
  });
it("fast completion cancels the pending spinner and receipt changes keep terminal geometry", async () => {
  const [event, setEvent] = createSignal({ ...base, at: new Date().toISOString() });
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const setup = await renderForTest(
    () => (
      <box width={70} height={2}>
        <PaneInteraction theme={theme} event={event()} paneName={name} width={70} />
        <text>Terminal content</text>
      </box>
    ),
    { width: 70, height: 2 },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("↳ Read requested");
  setEvent({ ...event(), phase: "observed" });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("✓ Read by Codex");
  await Bun.sleep(220);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toBe(frame);
});
it("old pending history and reduced motion remain static", async () => {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const reduced = { ...theme, accessibility: { ...theme.accessibility, reducedMotion: true } };
  const setup = await renderForTest(
    () => (
      <box width={70} height={2}>
        <PaneInteraction theme={theme} event={{ ...base, at: "2020-01-01T00:00:00Z" }} width={70} />
        <PaneInteraction
          theme={reduced}
          event={{ ...base, at: new Date().toISOString() }}
          width={70}
        />
      </box>
    ),
    { width: 70, height: 2 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  await Bun.sleep(230);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toBe(frame);
});
it("urgent lifecycle state wins over a compact receipt", async () => {
  const setup = await renderForTest(
    () => (
      <AgentRow
        theme={createSemanticThemeSnapshot({ mode: "dark" })}
        id="a"
        name="Tests"
        context="Local"
        activity="waiting"
        interaction={{ ...base, phase: "observed" }}
        paneName={name}
        width={36}
        onOpen={() => {}}
      />
    ),
    { width: 36, height: 2 },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Needs input");
  expect(setup.captureCharFrame()).not.toContain("Read by");
});

it("names a current alias while retaining native provenance and unknown caller", async () => {
  const event: PaneInteractionEvent = {
    ...base,
    phase: "observed",
    origin: "external",
    sourceEndpoint: null,
    sourcePaneId: null,
    destinationEndpoint: {
      kind: "native-pane",
      environmentId: endpoint("target").environmentId,
      serverScope: endpoint("target").serverScope,
      serverEpoch: "00000000-0000-4000-8000-000000000001",
      paneBirthId: "7",
    },
    displayDestinationEndpoint: endpoint("target"),
    effect: { kind: "snapshot-produced" },
  };
  const setup = await renderForTest(
    () => (
      <PaneInteraction
        theme={createSemanticThemeSnapshot({ mode: "dark" })}
        event={event}
        paneName={name}
        width={70}
      />
    ),
    { width: 70, height: 1 },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Pane read · reader unknown");
  expect(event.destinationEndpoint.kind).toBe("native-pane");
  setup.renderer.destroy();
});
