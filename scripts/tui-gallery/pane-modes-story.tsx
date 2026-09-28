/* @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../../packages/daemon/src/tui/mirror/theme.ts";
import { clipTerminal } from "../../packages/daemon/src/tui/mirror/terminal-text.ts";
import { TuiButton } from "../../packages/daemon/src/tui/mirror/ui/button.tsx";
import { OverlayFrame } from "../../packages/daemon/src/tui/mirror/ui/overlay-frame.tsx";
import { PaneInteraction } from "../../packages/daemon/src/tui/mirror/ui/pane-interaction.tsx";
import { PaneModeControl } from "../../packages/daemon/src/tui/mirror/ui/pane-mode-control.tsx";
import type { PaneInteractionEvent } from "../../packages/daemon/src/tui/mirror/ui/pane-interaction-presentation.ts";
import { galleryEndpoint } from "./fixtures.ts";
import { createInteractionPlayback } from "./pane-interaction-playback.ts";
import { useKeyboardRoute } from "../../packages/daemon/src/tui/mirror/ui/keyboard-router.tsx";

/** Proposed layout only. Playback timers simulate receipts; no real actions. */
const INTERACTIONS = [
  {
    label: "Read requested · identifying reader",
    short: "Read requested",
    detail: "A read of this pane was accepted.\nThe reader is not authenticated yet.",
    source: "Reader not yet verified",
    phase: "Read accepted",
  },
  {
    label: "Read by Codex · just now",
    short: "Read by Codex",
    detail: "The pane read completed.\nThis confirms access to output, not comprehension.",
    source: "Codex · Local / main / %3",
    phase: "Read completed",
  },
  {
    label: "Input pending · identifying sender",
    short: "Input pending",
    detail: "Input delivery was requested.\nDelivery and sender attribution are not yet confirmed.",
    source: "Sender not yet verified",
    phase: "Send accepted",
  },
  {
    label: "Input received from Reviewer",
    short: "Input from Reviewer",
    detail: "Input delivery was observed.\nThis does not mean Claude has processed the message.",
    source: "Reviewer · Local / main / %5",
    phase: "Input delivered",
  },
  {
    label: "Read failed · reader unverified",
    short: "Read failed",
    detail: "The pane read was rejected.\nDo not present this as a successful read.",
    source: "Reader not verified",
    phase: "Read rejected",
  },
  {
    label: "Send command · sender unknown",
    short: "Send command",
    detail:
      "A send command was observed through external tmux.\nDelivery and source agent are not verified.",
    source: "External tmux · unknown actor",
    phase: "Command observed",
  },
  {
    label: "",
    short: "",
    detail:
      "No recent interaction. Earlier receipts belong in history.\nThe reserved row stays in place when feedback expires.",
    source: "None",
    phase: "Quiet",
  },
] as const;

export function PaneModesStory(props: {
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
  interacting: boolean;
  record: (action: string) => void;
}) {
  const [mode, setMode] = createSignal(1); // live, scrollback, expanded, both
  const [event, setEvent] = createSignal(0);
  const [receiptAt, setReceiptAt] = createSignal("2020-01-01T00:00:00Z");
  const [playing, setPlaying] = createSignal(false);
  const [motion, setMotion] = createSignal(true);
  const [fast, setFast] = createSignal(false);
  const [kind, setKind] = createSignal<"read" | "send">("read");
  const [lastResult, setLastResult] = createSignal(6);
  const [inspected, setInspected] = createSignal(0);
  const playback = createInteractionPlayback((value, active) => {
    setEvent(value);
    if (value !== 6) setReceiptAt(new Date().toISOString());
    setPlaying(active);
    if (value === 1 || value === 3) setLastResult(value);
  });
  onCleanup(playback.stop);
  const stop = () => {
    playback.stop();
    setPlaying(false);
  };
  const play = () => {
    if (playing()) {
      stop();
      setEvent(6);
    } else playback.play(kind(), fast());
  };
  const receipt = (): PaneInteractionEvent => ({
    operationId: `fixture-${event()}`,
    operationKind:
      event() === 2 || event() === 3 || event() === 5
        ? "workspace.pane.send"
        : "workspace.pane.read",
    phase: event() === 0 || event() === 2 ? "accepted" : event() === 4 ? "rejected" : "observed",
    origin: event() === 5 ? "external" : "tui",
    sourcePaneId: event() === 1 ? "codex" : event() === 3 ? "reviewer" : null,
    destinationPaneId: "claude",
    sourceEndpoint:
      event() === 1 ? galleryEndpoint("codex") : event() === 3 ? galleryEndpoint("reviewer") : null,
    destinationEndpoint: galleryEndpoint("claude"),
    effect:
      event() === 1
        ? { kind: "snapshot-produced" }
        : event() === 3
          ? { kind: "input-enqueued" }
          : { kind: "unknown" },
    at: receiptAt(),
  });
  const actorName = (endpoint: ReturnType<typeof galleryEndpoint>) =>
    ({ codex: "Codex", reviewer: "Reviewer", claude: "Claude" })[endpoint.semanticPaneId];
  const inspect = () => {
    setInspected(event() === 6 ? lastResult() : event());
    setDetails(true);
  };
  const [details, setDetails] = createSignal(false);
  const [menu, setMenu] = createSignal(false);
  const scrollback = () => mode() === 1 || mode() === 3;
  const expanded = () => mode() === 2 || mode() === 3;
  const narrow = () => props.width < 80;
  const r = () => props.theme.roles;
  const close = () => {
    setDetails(false);
    setMenu(false);
  };
  const returnLive = () => {
    setMode(expanded() ? 2 : 0);
    props.record("Back to live (preview only)");
  };
  const restore = () => {
    setMode(scrollback() ? 1 : 0);
    props.record("Restore layout (preview only)");
  };
  useKeyboardRoute((e) => {
    if (!props.interacting || e.ctrl || e.meta || e.eventType !== "press") return false;
    if (e.name === "escape") close();
    else if (details() || menu()) return true;
    else if (e.name === "m") setMode((v) => (v + 1) % 4);
    else if (e.name === "i") {
      stop();
      setReceiptAt("2020-01-01T00:00:00Z");
      setEvent((v) => (v + 1) % INTERACTIONS.length);
    } else if (e.name === "p") play();
    else if (e.name === "a") setMotion((v) => !v);
    else if (e.name === "f") {
      stop();
      setFast((v) => !v);
    } else if (e.name === "s") {
      stop();
      setKind((v) => (v === "read" ? "send" : "read"));
    } else if (e.name === "d") inspect();
    else if (e.name === "return" || e.name === "enter") {
      if (scrollback()) returnLive();
      else if (expanded()) restore();
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  });
  const Button = (p: { label: string; onPress: () => void }) => (
    <TuiButton theme={props.theme} size="compact" label={p.label} onPress={p.onPress} />
  );
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      backgroundColor={r().surfaces.canvas}
    >
      <text height={1} fg={r().text.muted}>
        {clipTerminal("PREVIEW · M mode · I step · D details · Enter action", props.width)}
      </text>
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        backgroundColor={r().surfaces.panel}
        gap={1}
      >
        <Button label="⋯" onPress={() => setMenu(true)} />
        <text fg={r().text.primary} width={narrow() ? 6 : 14}>
          <strong>Claude</strong>
        </text>
        <box flexGrow={1} />
        <Show when={scrollback() || expanded()} fallback={<text fg={r().text.muted}>Live</text>}>
          <PaneModeControl
            theme={props.theme}
            width={scrollback() ? (narrow() ? 24 : 43) : 20}
            scrollback={scrollback()}
            linesAboveLive={84}
            onBackToLive={returnLive}
            onRestore={restore}
          />
        </Show>
        <Show when={!narrow()}>
          <text fg={r().text.secondary}> Working </text>
        </Show>
      </box>
      <box height={1} flexShrink={0} width={props.width} backgroundColor={r().surfaces.panelRaised}>
        <Show when={event() !== 6}>
          <PaneInteraction
            theme={{
              ...props.theme,
              accessibility: {
                ...props.theme.accessibility,
                reducedMotion: props.theme.accessibility.reducedMotion || !motion(),
              },
            }}
            event={receipt()}
            paneName={actorName}
            width={props.width}
            onDetails={inspect}
          />
        </Show>
      </box>
      <box height={1} flexShrink={0} flexDirection="row" gap={1}>
        <Button label={playing() ? "P Stop" : "P Play"} onPress={play} />
        <Button label={motion() ? "A Motion" : "A Static"} onPress={() => setMotion((v) => !v)} />
        <Button
          label={fast() ? "F Fast" : "F Slow"}
          onPress={() => {
            stop();
            setFast((v) => !v);
          }}
        />
        <Button
          label={kind() === "read" ? "S Read" : "S Send"}
          onPress={() => {
            stop();
            setKind((v) => (v === "read" ? "send" : "read"));
          }}
        />
      </box>
      <box flexGrow={1} padding={1} flexDirection="column" gap={1}>
        <text fg={r().text.muted}>
          {scrollback() ? "Earlier output · live output continues" : "Live terminal output"}
        </text>
        <text fg={r().text.primary}>
          {"$ pnpm test\n\n  ✓ pane identity\n  ✓ keyboard ownership\n  ✓ resize reconciliation"}
        </text>
        <Show when={expanded() && !narrow()}>
          <text fg={r().text.muted}>Other panes are hidden, still running.</text>
        </Show>
      </box>
      <text height={1} fg={r().text.muted}>
        {clipTerminal("Agents can read pane output and send input through tmux.", props.width)}
      </text>
      <Show when={details() || menu()}>
        <OverlayFrame
          theme={props.theme}
          viewportWidth={props.width}
          viewportHeight={props.height}
          width={72}
          height={20}
          title={menu() ? "Pane actions" : "Pane interaction"}
          surface
          modal
          onDismiss={close}
        >
          <scrollbox flexGrow={1}>
            <box flexDirection="column" gap={1}>
              <Show
                when={menu()}
                fallback={
                  <>
                    <text fg={r().text.primary}>
                      <strong>{INTERACTIONS[inspected()]!.phase}</strong>
                    </text>
                    <text fg={r().text.secondary}>{INTERACTIONS[inspected()]!.detail}</text>
                    <text fg={r().text.muted}>From</text>
                    <text fg={r().text.primary}>{INTERACTIONS[inspected()]!.source}</text>
                    <text fg={r().text.muted}>To</text>
                    <text fg={r().text.primary}>Claude · Local / main / %1</text>
                    <text fg={r().text.secondary}>
                      Pane reads do not change your focus or take control.
                    </text>
                    <text fg={r().text.muted}>
                      Simulated receipt. Only verified actors get names.
                    </text>
                  </>
                }
              >
                <Show when={scrollback()}>
                  <Button
                    label="Back to live"
                    onPress={() => {
                      returnLive();
                      close();
                    }}
                  />
                </Show>
                <Show when={expanded()}>
                  <Button
                    label="Restore layout"
                    onPress={() => {
                      restore();
                      close();
                    }}
                  />
                </Show>
                <Button
                  label="Interaction details"
                  onPress={() => {
                    setMenu(false);
                    inspect();
                  }}
                />
              </Show>
              <Button label="Close · Esc" onPress={close} />
            </box>
          </scrollbox>
        </OverlayFrame>
      </Show>
    </box>
  );
}
