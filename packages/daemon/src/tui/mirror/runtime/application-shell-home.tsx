import { paneInteractionDisplayDestination } from "../ui/pane-interaction-presentation.ts";
import type { InteractionObservationStatus, InteractionPaneEndpoint } from "@tmux-ide/contracts";
import { interactionActivityAt, interactionPaneEndpointKey } from "@tmux-ide/core";
import type { PaneInteractionEndpoint } from "../ui/pane-interaction-presentation.ts";
import {
  interactionForCurrentPane,
  nameForCurrentEndpoint,
} from "../ui/pane-interaction-presentation.ts";
import type { InteractionJournalEntry } from "@tmux-ide/contracts";

/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import { For, Show, createEffect, createSignal } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { SectionHeading } from "../ui/section-heading.tsx";
import { KeyHint } from "../ui/key-hint.tsx";
import { CHROME_ACTIONS, HOME_ACTIONS } from "../workspace/application-action-descriptions.ts";
import { PaneInteraction, PaneInteractionDetails } from "../ui/pane-interaction.tsx";
import {
  receiptPaneInteraction,
  interactionTargetsPane,
  type PaneInteractionEvent,
} from "../ui/pane-interaction-presentation.ts";
import { TuiButton } from "../ui/button.tsx";
import type { ApplicationTerminalAgentIndicator } from "./application-terminal-workspace-policy.ts";
import { HomeAgentRoster } from "./application-home-agent-roster.tsx";
import type { HomeAgentRow, HomeAgentSnapshot } from "./application-home-agents.ts";
import type { HomeAgentSelectionSnapshot } from "./application-home-agent-selection.ts";

import { APPLICATION_HOME_WORDMARK, APPLICATION_HOME_WORDMARK_WIDTH } from "../ui/home-wordmark.ts";

export type ApplicationHomeBrandVariant = "wordmark" | "ascii";

/** Keep the marketing wordmark intact, falling back when the agent list needs the room. */
export function applicationHomeBrandVariant(
  width: number,
  height: number,
): ApplicationHomeBrandVariant {
  return width >= APPLICATION_HOME_WORDMARK_WIDTH && height >= 28 ? "ascii" : "wordmark";
}

export interface ApplicationHomeSurfaceProps {
  readonly project: string;
  readonly status: string;
  readonly note: string | null;
  readonly width: number;
  readonly height: number;
  readonly sessionCount: number;
  readonly session?: string | null;
  readonly agents?: readonly ApplicationTerminalAgentIndicator[];
  readonly branded: boolean;
  readonly theme: SemanticThemeSnapshot;
  readonly onOpenTerminals: () => void;
  readonly onOpenCommands: () => void;
  readonly onBrowseSessions?: () => void;
  readonly onAddMachine?: () => void;
  readonly onOpenTutorial?: () => void;
  readonly tutorialLabel?: string;
  readonly onCycleTheme?: () => void;
  readonly agentQuery?: string;
  readonly onAgentQueryChange?: (query: string) => void;
  readonly agentFilterLabel?: string;
  readonly agentActivityFilter?: "all" | "working" | "attention";
  readonly onSetAgentActivityFilter?: (value: "all" | "working" | "attention") => void;
  readonly onCycleAgentMachine?: () => void;
  readonly onToggleAgentAttention?: () => void;
  readonly agentRoster?: HomeAgentSnapshot;
  readonly activityDaemonId?: string | null;
  readonly interactionObservation?: (
    endpoint: InteractionPaneEndpoint,
  ) => InteractionObservationStatus | null;
  readonly paneInteractions?: ReadonlyMap<string, PaneInteractionEvent>;
  readonly recentPaneActivity?: readonly InteractionJournalEntry[];
  readonly agentSelection?: HomeAgentSelectionSnapshot;
  readonly agentInputActive?: boolean;
  readonly onSelectAgent?: (key: string) => void;
  readonly onMoveAgent?: (delta: number) => void;
  readonly onAgentViewport?: (rows: number) => void;
  readonly onOpenAgent?: (row: HomeAgentRow, source: "keyboard" | "mouse") => void;
  readonly onRetryAgents?: () => void;
  readonly onLoadMoreAgents?: () => void;
}

/** Presentation only: session data, commands, and keyboard admission stay with the shell. */
export function ApplicationHomeSurface(props: ApplicationHomeSurfaceProps): JSX.Element {
  const [inspection, setInspection] = createSignal<{
    event: PaneInteractionEvent;
    names: ReadonlyMap<string, string>;
    key: string;
  } | null>(null);
  const [tipHidden, setTipHidden] = createSignal(false);
  const width = () => Math.max(0, Math.floor(props.width));
  const height = () => Math.max(0, Math.floor(props.height));
  const inset = () =>
    Math.max(
      width() >= 40 ? 2 : width() >= 12 ? 1 : 0,
      props.branded ? Math.floor((width() - 88) / 2) : 0,
    );
  const bodyWidth = () => Math.max(0, width() - inset() * 2);
  const showAscii = () =>
    props.branded &&
    props.agentRoster?.phase === "live" &&
    props.agentRoster.rows.length === 0 &&
    !props.agentQuery &&
    (!props.agentActivityFilter || props.agentActivityFilter === "all") &&
    applicationHomeBrandVariant(bodyWidth(), height()) === "ascii";
  const brandRows = () => (showAscii() ? APPLICATION_HOME_WORDMARK.length : 1);
  const spacious = () => height() >= 14;
  const context = () =>
    clipTerminal(
      props.branded && props.agentRoster
        ? "Your agents, across your machines"
        : `${props.session ?? "No session selected"} · ${props.status}`,
      bodyWidth(),
    );
  const summary = () => {
    if (!props.session || props.agents === undefined) return "Agent signals unavailable";
    const working = props.agents.filter((agent) => agent.activity === "running").length;
    const attention = props.agents.filter((agent) => agent.attention).length;
    return `Current session · ${working} working · ${attention} ${attention === 1 ? "needs" : "need"} attention`;
  };
  const showSections = () => props.branded && height() >= 20;
  const showTip = () => props.branded && height() >= 30 && bodyWidth() >= 48 && !tipHidden();
  const primaryLabel = () => (props.onBrowseSessions ? "Browse sessions" : "Open terminals");
  const primaryKey = () =>
    props.onBrowseSessions ? CHROME_ACTIONS.sessions.keys : CHROME_ACTIONS.terminals.keys;
  const secondaryLabel = () => (props.onAddMachine ? "Add machine" : "Commands");
  const secondaryKey = () => (props.onAddMachine ? undefined : CHROME_ACTIONS.commands.keys);
  const showTheme = () => !props.onAddMachine && props.onCycleTheme;
  const themeLabel = () => `Theme: ${props.theme.setting}`;
  // Use the existing TuiButton cell budget for both its label and hit target.
  const naturalButtonWidth = (label: string, shortcut?: string) =>
    terminalDisplayWidth(label) + (shortcut ? terminalDisplayWidth(shortcut) + 1 : 0) + 2;
  const buttonWidth = (label: string, shortcut?: string) =>
    Math.min(bodyWidth(), naturalButtonWidth(label, shortcut));
  const actionsInRow = () =>
    bodyWidth() >=
    naturalButtonWidth(primaryLabel(), primaryKey()) +
      naturalButtonWidth(secondaryLabel(), secondaryKey()) +
      (showTheme() ? naturalButtonWidth(themeLabel()) + 2 : 0) +
      (props.onOpenTutorial ? naturalButtonWidth(props.tutorialLabel ?? "Learn tmux-ide") + 2 : 0) +
      2;
  const reservedRows = () =>
    (showSections() ? 1 : 0) +
    (showTip() ? 2 : 0) +
    brandRows() -
    1 +
    (spacious() ? 4 : 2) +
    (actionsInRow() ? 1 : 2 + (showTheme() ? 1 : 0) + (props.onOpenTutorial ? 1 : 0)) +
    (spacious() ? 1 : 0) +
    (props.note ? (spacious() ? 2 : 1) : 0);
  const activityRows = () => (height() >= 24 && bodyWidth() >= 48 ? 2 : 1);
  const selectedAgent = () =>
    props.agentRoster?.rows.find((row) => row.key === props.agentSelection?.selectedKey);
  const selectedActivity = () => {
    const endpoint = selectedAgent()?.interactionEndpoint;
    if (!endpoint) return [];
    return (props.recentPaneActivity ?? []).filter((receipt) =>
      interactionTargetsPane(receipt, endpoint, selectedAgent()?.nativeIdentity),
    );
  };
  const recentActivity = () =>
    selectedActivity().slice(
      0,
      spacious()
        ? Math.max(
            0,
            Math.min(
              1,
              Math.floor(
                (height() - reservedRows() - (props.agentRoster ? 10 : 2) - 2) / activityRows(),
              ),
            ),
          )
        : 0,
    );
  const activityHeight = () =>
    recentActivity().length > 0 ? recentActivity().length * activityRows() + 2 : 0;
  createEffect(() => {
    const value = inspection();
    if (value && value.key !== `${props.activityDaemonId}:${selectedAgent()?.key}`)
      setInspection(null);
  });
  const paneLabel = (endpoint: PaneInteractionEndpoint) =>
    nameForCurrentEndpoint(props.agentRoster?.rows ?? [], endpoint);
  const activityTime = (receipt: InteractionJournalEntry) => {
    const at = Date.parse(interactionActivityAt(receipt));
    return Number.isFinite(at)
      ? `${new Date(at).toISOString().slice(5, 16).replace("T", " ")}Z`
      : "Time unknown";
  };
  const inspect = (event: PaneInteractionEvent) => {
    const names = new Map<string, string>();
    for (const endpoint of [event.sourceEndpoint, paneInteractionDisplayDestination(event)]) {
      if (!endpoint) continue;
      const name = paneLabel(endpoint);
      if (name) names.set(interactionPaneEndpointKey(endpoint), name);
    }
    setInspection({
      event: { ...event },
      names,
      key: `${props.activityDaemonId}:${selectedAgent()?.key}`,
    });
  };
  const rosterHeight = () => Math.max(0, height() - reservedRows() - activityHeight());

  return (
    <box
      id="application-home"
      width={width()}
      height={height()}
      paddingLeft={inset()}
      paddingRight={inset()}
      paddingTop={spacious() ? 1 : 0}
      flexDirection="column"
      alignItems="flex-start"
      backgroundColor={props.theme.roles.surfaces.canvas}
      overflow="hidden"
    >
      <box height={brandRows()} width={bodyWidth()} flexShrink={0} flexDirection="column">
        <Show
          when={showAscii()}
          fallback={
            <text width={bodyWidth()} height={1} fg={props.theme.roles.text.primary}>
              <strong>
                {clipTerminal(
                  props.branded
                    ? props.agentRoster?.rows.length
                      ? "Agents"
                      : "tmux-ide"
                    : props.project,
                  bodyWidth(),
                )}
              </strong>
            </text>
          }
        >
          <For each={APPLICATION_HOME_WORDMARK}>
            {(line) => (
              <text
                width={bodyWidth()}
                height={1}
                flexShrink={0}
                fg={props.theme.roles.text.primary}
              >
                {" ".repeat(
                  Math.max(0, Math.floor((bodyWidth() - APPLICATION_HOME_WORDMARK_WIDTH) / 2)),
                ) + line}
              </text>
            )}
          </For>
        </Show>
      </box>
      <box height={spacious() ? 1 : 0} flexShrink={0} />
      <text width={bodyWidth()} height={1} flexShrink={0} fg={props.theme.roles.text.secondary}>
        {context()}
      </text>
      <Show when={props.branded}>
        <Show
          when={props.agentRoster}
          fallback={
            <>
              <text width={bodyWidth()} height={1} flexShrink={0} fg={props.theme.roles.text.muted}>
                {clipTerminal(
                  `${props.sessionCount} ${props.sessionCount === 1 ? "session" : "sessions"} in view`,
                  bodyWidth(),
                )}
              </text>
              <text
                width={bodyWidth()}
                height={1}
                flexShrink={0}
                fg={props.theme.roles.text.primary}
              >
                {clipTerminal(summary(), bodyWidth())}
              </text>
            </>
          }
        >
          {(snapshot) => (
            <HomeAgentRoster
              fitContent
              query={props.agentQuery}
              onQueryChange={props.onAgentQueryChange}
              filterLabel={props.agentFilterLabel}
              activityFilter={props.agentActivityFilter}
              onSetActivityFilter={props.onSetAgentActivityFilter}
              onCycleMachine={props.onCycleAgentMachine}
              onToggleAttention={props.onToggleAgentAttention}
              theme={props.theme}
              width={bodyWidth()}
              height={rosterHeight()}
              paneName={paneLabel}
              interactionForAgent={(row) =>
                interactionForCurrentPane(
                  props.paneInteractions,
                  row.interactionEndpoint,
                  row.nativeIdentity,
                )
              }
              snapshot={snapshot()}
              selection={props.agentSelection ?? { selectedKey: null, scrollOffset: 0 }}
              inputActive={(props.agentInputActive ?? false) && !inspection()}
              onSelect={(key) => props.onSelectAgent?.(key)}
              onMove={(delta) => props.onMoveAgent?.(delta)}
              onViewport={(rows) => props.onAgentViewport?.(rows)}
              onOpen={(row, source) => props.onOpenAgent?.(row, source)}
              onRetry={props.onRetryAgents}
              onLoadMore={props.onLoadMoreAgents}
            />
          )}
        </Show>
        <Show when={activityHeight() > 0}>
          <box
            width={bodyWidth()}
            height={activityHeight()}
            flexShrink={0}
            flexDirection="column"
            overflow="hidden"
          >
            <text height={1} width={bodyWidth()} fg={props.theme.roles.text.secondary}>
              {clipTerminal(`${selectedAgent()?.name ?? "Agent"} · latest activity`, bodyWidth())}
            </text>
            <For each={recentActivity()}>
              {(receipt) => (
                <box height={activityRows()} width={bodyWidth()} flexDirection="column">
                  <Show
                    when={receiptPaneInteraction(
                      receipt,
                      selectedAgent()?.interactionEndpoint,
                      selectedAgent()?.nativeIdentity,
                    )}
                    keyed
                  >
                    {(event) => (
                      <PaneInteraction
                        theme={props.theme}
                        event={event}
                        paneName={paneLabel}
                        width={bodyWidth()}
                        onDetails={() => inspect(event)}
                      />
                    )}
                  </Show>
                  <Show when={activityRows() === 2}>
                    <text height={1} fg={props.theme.roles.text.muted}>
                      {activityTime(receipt)}
                    </text>
                  </Show>
                </box>
              )}
            </For>
            <text height={1} width={bodyWidth()} fg={props.theme.roles.text.muted}>
              {clipTerminal("Activity reported through tmux-ide", bodyWidth())}
            </text>
          </box>
        </Show>
        <box height={spacious() ? 1 : 0} flexShrink={0} />
        <Show when={showSections()}>
          <SectionHeading theme={props.theme} width={bodyWidth()} title="Quick actions" />
        </Show>
        <box
          width={bodyWidth()}
          flexShrink={0}
          flexDirection={actionsInRow() ? "row" : "column"}
          alignItems="flex-start"
          gap={actionsInRow() ? 2 : 0}
        >
          <TuiButton
            theme={props.theme}
            label={primaryLabel()}
            shortcut={primaryKey()}
            width={buttonWidth(primaryLabel(), primaryKey())}
            size="compact"
            variant="ghost"
            background={props.theme.roles.surfaces.canvas}
            onPress={props.onBrowseSessions ?? props.onOpenTerminals}
          />
          <TuiButton
            theme={props.theme}
            label={secondaryLabel()}
            size="compact"
            variant="ghost"
            background={props.theme.roles.surfaces.canvas}
            shortcut={secondaryKey()}
            width={buttonWidth(secondaryLabel(), secondaryKey())}
            onPress={props.onAddMachine ?? props.onOpenCommands}
          />
          <Show when={props.onOpenTutorial}>
            {(open) => (
              <TuiButton
                theme={props.theme}
                label={props.tutorialLabel ?? "Learn tmux-ide"}
                size="compact"
                variant="ghost"
                background={props.theme.roles.surfaces.canvas}
                width={buttonWidth(props.tutorialLabel ?? "Learn tmux-ide")}
                onPress={open()}
              />
            )}
          </Show>
          <Show when={showTheme()}>
            {(onCycleTheme) => (
              <TuiButton
                theme={props.theme}
                label={themeLabel()}
                width={buttonWidth(themeLabel())}
                size="compact"
                variant="ghost"
                background={props.theme.roles.surfaces.canvas}
                onPress={onCycleTheme()}
              />
            )}
          </Show>
        </box>
      </Show>
      <Show when={showTip()}>
        <box
          height={2}
          width={bodyWidth()}
          flexShrink={0}
          paddingTop={1}
          flexDirection="row"
          overflow="hidden"
        >
          <text fg={props.theme.roles.text.link}>Tip </text>
          <KeyHint theme={props.theme} keys={HOME_ACTIONS.open.keys} quiet />
          <text fg={props.theme.roles.text.muted} width={Math.max(0, bodyWidth() - 14)}>
            {clipTerminal(" opens the selected agent’s pane.", Math.max(0, bodyWidth() - 14))}
          </text>
          <TuiButton
            theme={props.theme}
            label="×"
            size="compact"
            width={3}
            onPress={() => setTipHidden(true)}
          />
        </box>
      </Show>
      <Show when={props.note}>
        {(note) => (
          <text
            width={bodyWidth()}
            height={1}
            flexShrink={0}
            marginTop={spacious() ? 1 : 0}
            fg={props.theme.roles.text.link}
          >
            {clipTerminal(note(), bodyWidth())}
          </text>
        )}
      </Show>
      <Show when={inspection()} keyed>
        {(value) => (
          <Show when={value.key === `${props.activityDaemonId}:${selectedAgent()?.key}`}>
            <PaneInteractionDetails
              theme={props.theme}
              event={value.event}
              observationStatus={props.interactionObservation?.(value.event.destinationEndpoint)}
              paneName={(id) => value.names.get(interactionPaneEndpointKey(id))}
              width={bodyWidth()}
              viewportWidth={props.width}
              viewportHeight={props.height}
              onDismiss={() => setInspection(null)}
            />
          </Show>
        )}
      </Show>
    </box>
  );
}
