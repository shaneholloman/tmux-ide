/* @jsxImportSource @opentui/solid */
import { useKeyboard, usePaste } from "@opentui/solid";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  Switch,
  Match,
  For,
} from "solid-js";
import { createHomeAgentSelectionOwner } from "../../packages/daemon/src/tui/mirror/runtime/application-home-agent-selection.ts";
import { ApplicationHomeSurface } from "../../packages/daemon/src/tui/mirror/runtime/application-shell-home.tsx";
import { ApplicationMachineSidebar } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-sidebar.tsx";
import { ApplicationReferenceSheet } from "../../packages/daemon/src/tui/mirror/runtime/application-reference-sheet.tsx";
import { createSemanticThemeSnapshot } from "../../packages/daemon/src/tui/mirror/theme.ts";
import {
  createKeyboardRouteOwner,
  KeyboardRouteProvider,
} from "../../packages/daemon/src/tui/mirror/ui/keyboard-router.tsx";
import { WorkingSessionsStory } from "./working-sessions.tsx";
import { PaneModesStory } from "./pane-modes-story.tsx";
import { PaneHeaderStory, FooterStory } from "./chrome-stories.tsx";
import { GALLERY_STATES, galleryAgents, galleryMachines } from "./fixtures.ts";

export function TuiGallery(props: {
  width: number;
  height: number;
  onQuit: () => void;
  onAction?: (action: string) => void;
  initial?: {
    story?: number;
    light?: boolean;
    narrow?: boolean;
    state?: number;
    interacting?: boolean;
  };
}) {
  const [story, setStory] = createSignal(props.initial?.story ?? 0);
  const [light, setLight] = createSignal(props.initial?.light ?? false);
  const [narrow, setNarrow] = createSignal(props.initial?.narrow ?? false);
  const [state, setState] = createSignal(props.initial?.state ?? 0);
  const [interacting, setInteracting] = createSignal(props.initial?.interacting ?? false);
  const [revision, setRevision] = createSignal(1);
  const [action, setAction] = createSignal("No actions yet (fixtures only)");
  const theme = createMemo(() => createSemanticThemeSnapshot({ mode: light() ? "light" : "dark" }));
  const owner = createKeyboardRouteOwner();
  onCleanup(() => owner.dispose());
  const reset = () => {
    setRevision((n) => n + 1);
    setAction("Reset fixture");
  };
  const record = (value: string) => {
    setAction(value);
    props.onAction?.(value);
  };
  useKeyboard((event) => {
    if (event.eventType === "release") return;
    if (event.name === "f12") {
      setInteracting((v) => !v);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (interacting()) {
      owner.route(event);
      return;
    }
    if (event.ctrl || event.meta) return;
    if (["1", "2", "3", "4", "5", "6", "7"].includes(event.name)) {
      setStory(Number(event.name) - 1);
      reset();
    } else if (event.name === "t") setLight((v) => !v);
    else if (event.name === "v") setNarrow((v) => !v);
    else if (event.name === "s") {
      setState((v) => (v + 1) % GALLERY_STATES.length);
      reset();
    } else if (event.name === "r") reset();
    else if (event.name === "q") props.onQuit();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  usePaste((event) => {
    if (interacting()) owner.routePaste(event.bytes);
  });
  const width = () => Math.max(1, Math.min(props.width, narrow() ? 48 : 112));
  const height = () => Math.max(1, Math.min(props.height - 6, narrow() ? 18 : 30));
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      backgroundColor={theme().colors.background}
    >
      <text fg={theme().colors.foreground}>
        Production TUI gallery · {interacting() ? "INTERACT" : "CONTROLS"} · F12 toggle
      </text>
      <text fg={theme().colors.mutedForeground}>
        1 Home 2 Sidebar 3 Help 4 Pane 5 Footer 6 Work 7 Modes
      </text>
      <text fg={theme().colors.mutedForeground}>t Theme v Size s State r Reset q Quit</text>
      <text fg={theme().colors.foreground}>
        {
          [
            "Home",
            "Sidebar",
            "Help",
            "Pane header",
            "Footer",
            "Working sessions",
            "Pane modes preview",
          ][story()]
        }{" "}
        · {GALLERY_STATES[state()]} · {light() ? "light" : "dark"} · {width()}×{height()}
      </text>
      <KeyboardRouteProvider owner={owner}>
        <For each={[revision()]}>
          {() => (
            <GalleryStory
              story={story()}
              state={state()}
              width={width()}
              height={height()}
              theme={theme()}
              interacting={interacting()}
              record={record}
            />
          )}
        </For>
      </KeyboardRouteProvider>
      <text fg={theme().colors.mutedForeground}>{action()}</text>
    </box>
  );
}
function GalleryStory(props: {
  story: number;
  state: number;
  width: number;
  height: number;
  theme: ReturnType<typeof createSemanticThemeSnapshot>;
  interacting: boolean;
  record: (value: string) => void;
}) {
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<"all" | "working" | "attention">("all");
  const [local, setLocal] = createSignal(false);
  const selectionOwner = createHomeAgentSelectionOwner();
  const [selection, setSelection] = createSignal(selectionOwner.snapshot());
  const unsubscribeSelection = selectionOwner.subscribe(setSelection);
  onCleanup(() => {
    unsubscribeSelection();
    selectionOwner.dispose();
  });
  const [closed, setClosed] = createSignal(false);
  const [machine, setMachine] = createSignal<string | null>("local");
  const snapshot = createMemo(() => {
    const base = galleryAgents(GALLERY_STATES[props.state]!);
    return {
      ...base,
      rows: base.rows.filter(
        (r) =>
          r.name.toLowerCase().includes(query().toLowerCase()) &&
          (!local() || r.machineId === "local") &&
          (filter() === "all" || (filter() === "working" ? r.activity === "running" : r.attention)),
      ),
    };
  });
  createEffect(() => selectionOwner.setRows(snapshot().rows));
  return (
    <box width={props.width} height={props.height} flexShrink={0} overflow="hidden">
      <Switch>
        <Match when={props.story === 6}>
          <PaneModesStory {...props} />
        </Match>
        <Match when={props.story === 0}>
          <ApplicationHomeSurface
            project="tmux-ide"
            status="live"
            note={null}
            sessionCount={2}
            branded
            onOpenTerminals={() => props.record("Terminals (simulated)")}
            onOpenCommands={() => props.record("Commands (simulated)")}
            onBrowseSessions={() => props.record("Sessions (simulated)")}
            onAddMachine={() => props.record("Add machine (simulated)")}
            onOpenTutorial={() => props.record("Help (simulated)")}
            tutorialLabel="Using tmux-ide"
            theme={props.theme}
            width={props.width}
            height={props.height}
            activityDaemonId="fixture-daemon"
            recentPaneActivity={
              GALLERY_STATES[props.state] === "offline"
                ? []
                : [
                    {
                      type: "interaction.receipt",
                      sequence: 1,
                      operationId: "10000000-0000-4000-8000-000000000001",
                      origin: "tui",
                      workspaceName: "tmux-ide",
                      sourceSemanticPaneId: "pane.2",
                      target: { kind: "pane", semanticPaneId: "pane.0" },
                      operationKind: "workspace.pane.read",
                      summary: { operationKind: "workspace.pane.read", observedOnly: true },
                      phase: "observed",
                      proof: {
                        operationKind: "workspace.pane.read",
                        observed: true,
                        semanticPaneId: "pane.0",
                      },
                      at: "2026-09-28T09:00:00.000Z",
                      resourceRevision: null,
                    },
                  ]
            }
            agentRoster={snapshot()}
            agentSelection={selection()}
            agentInputActive={props.interacting}
            agentQuery={query()}
            onAgentQueryChange={setQuery}
            agentActivityFilter={filter()}
            onSetAgentActivityFilter={setFilter}
            onToggleAgentAttention={() =>
              setFilter((value) => (value === "attention" ? "all" : "attention"))
            }
            agentFilterLabel={local() ? "Local" : "All machines"}
            onCycleAgentMachine={() => setLocal((v) => !v)}
            onSelectAgent={selectionOwner.select}
            onMoveAgent={selectionOwner.move}
            onAgentViewport={selectionOwner.setViewport}
            onOpenAgent={(row, source) => props.record(`Open ${row.name} (${source}; simulated)`)}
            onRetryAgents={() => props.record("Retry (simulated)")}
          />
        </Match>
        <Match when={props.story === 1}>
          <ApplicationMachineSidebar
            theme={props.theme}
            width={Math.min(props.width, 36)}
            height={props.height}
            onHelp={() => props.record("Help (simulated)")}
            model={{
              groups: () => galleryMachines(GALLERY_STATES[props.state]!),
              activeMachineId: machine,
              activeSessionName: () => "tmux-ide",
              focused: () => props.interacting,
              onSelectMachine: (id) => {
                setMachine(id);
                props.record(`Select ${id} (simulated)`);
              },
              onOpen: (_id, session) => props.record(`Open ${session} (simulated)`),
              onOpenAgent: (_id, _session, pane) => props.record(`Open ${pane} (simulated)`),
              onOpenSwitcher: () => props.record("Sessions (simulated)"),
              onOpenAttention: () => props.record("Attention (simulated)"),
              onAddMachine: () => props.record("Add machine (simulated)"),
              onRetryMachine: () => props.record("Retry (simulated)"),
              onDisconnectMachine: () => props.record("Disconnect (simulated)"),
            }}
          />
        </Match>
        <Match when={props.story === 2}>
          <Show
            when={!closed()}
            fallback={
              <text fg={props.theme.colors.foreground}>Dialog closed · F12 controls, r reopen</text>
            }
          >
            <ApplicationReferenceSheet
              page="help"
              width={props.width}
              height={props.height}
              theme={props.theme}
              onClose={() => {
                setClosed(true);
                props.record("Close Help (simulated)");
              }}
            />
          </Show>
        </Match>
        <Match when={props.story === 3}>
          <PaneHeaderStory {...props} state={GALLERY_STATES[props.state]!} />
        </Match>
        <Match when={props.story === 4}>
          <FooterStory {...props} state={GALLERY_STATES[props.state]!} />
        </Match>
        <Match when={props.story === 5}>
          <WorkingSessionsStory {...props} state={GALLERY_STATES[props.state]!} />
        </Match>
      </Switch>
    </box>
  );
}
