import type { PaneInteractionEndpoint } from "../ui/pane-interaction-presentation.ts";
import type { PaneInteractionEvent } from "../ui/pane-interaction-presentation.ts";
/* @jsxImportSource @opentui/solid */
import {
  HOME_ACTIONS,
  HOME_ACTIVITY_ACTIONS,
} from "../workspace/application-action-descriptions.ts";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { AgentRow } from "../ui/agent-row.tsx";
import { KeyHint } from "../ui/key-hint.tsx";
import { TuiButton } from "../ui/button.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";
import {
  applicationPaneRenameKeyAction,
  applicationPaneRenamePaste,
} from "./application-pane-rename-input.ts";
import { HomeAgentSearch } from "../ui/home-agent-search.tsx";
import { ActivityIndicator } from "../ui/activity-indicator.tsx";
import { type HomeAgentRow, type HomeAgentSnapshot } from "./application-home-agents.ts";
import type { HomeAgentSelectionSnapshot } from "./application-home-agent-selection.ts";

export interface HomeAgentRosterProps {
  readonly interactionForAgent?: (row: HomeAgentRow) => PaneInteractionEvent | undefined;
  readonly paneName?: (endpoint: PaneInteractionEndpoint) => string | undefined;
  readonly query?: string;
  readonly onQueryChange?: (query: string) => void;
  readonly filterLabel?: string;
  readonly activityFilter?: "all" | "working" | "attention";
  readonly onSetActivityFilter?: (value: "all" | "working" | "attention") => void;
  readonly onCycleMachine?: () => void;
  readonly onToggleAttention?: () => void;
  readonly theme: SemanticThemeSnapshot;
  readonly width: number;
  readonly height: number;
  readonly snapshot: HomeAgentSnapshot;
  readonly selection: HomeAgentSelectionSnapshot;
  readonly inputActive: boolean;
  readonly onSelect: (key: string) => void;
  readonly onMove: (delta: number) => void;
  readonly onViewport: (rows: number) => void;
  readonly onOpen: (row: HomeAgentRow, source: "keyboard" | "mouse") => void;
  readonly fitContent?: boolean;
  readonly onRetry?: () => void;
  readonly onLoadMore?: () => void;
}

/** A flat projected roster; no subscriptions, navigation effects, or terminal input ingress. */
export function HomeAgentRoster(props: HomeAgentRosterProps) {
  const [hovered, setHovered] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal(false);
  const width = () => Math.max(0, Math.floor(props.width));
  const height = () => Math.max(0, Math.floor(props.height));
  const stale = (row: HomeAgentRow) =>
    row.disabled ||
    (props.snapshot.refreshingSessionKeys ?? []).includes(row.sessionKey) ||
    (props.snapshot.unavailableSessionKeys ?? []).includes(row.sessionKey);
  const showRecovery = () =>
    Boolean(
      ((props.snapshot.phase === "unavailable" || props.snapshot.unavailableSessions > 0) &&
        props.onRetry) ||
      (props.snapshot.truncatedSessions > 0 && props.onLoadMore),
    );
  const rowHeight = () => (height() >= 14 ? 2 : 1);
  const compact = () => height() < 8;
  const filterRows = () => (compact() ? 0 : props.onSetActivityFilter && width() < 70 ? 2 : 1);
  const searchRows = () => (props.onQueryChange ? (compact() ? 1 : 2) : 0);
  const visibleCount = () =>
    Math.max(
      0,
      Math.floor(
        (height() - (compact() ? 1 : 4) - filterRows() - searchRows() - (showRecovery() ? 1 : 0)) /
          rowHeight(),
      ),
    );
  const openSelected = (source: "keyboard" | "mouse" = "keyboard") => {
    const row = props.snapshot.rows.find((row) => row.key === props.selection.selectedKey);
    if (props.inputActive && visibleCount() > 0 && row?.paneId && !stale(row))
      props.onOpen(row, source);
  };
  createEffect(() => props.onViewport(visibleCount()));
  const offset = () =>
    Math.max(
      0,
      Math.min(
        props.selection.scrollOffset,
        Math.max(0, props.snapshot.rows.length - visibleCount()),
      ),
    );
  const visible = createMemo(() => props.snapshot.rows.slice(offset(), offset() + visibleCount()));
  const byKey = createMemo(() => new Map(visible().map((row) => [row.key, row])));
  const keys = createMemo(() => visible().map((row) => row.key), undefined, {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
  });
  const filtered = () =>
    Boolean(props.query || (props.activityFilter && props.activityFilter !== "all"));
  const title = () => {
    if (props.snapshot.phase === "unavailable") return "Agent overview unavailable";
    if (props.snapshot.phase === "loading" && props.snapshot.rows.length === 0)
      return "Loading agent overview…";
    if (filtered() && props.snapshot.rows.length === 0) return "No matching agents";
    if (props.snapshot.phase === "live" && props.snapshot.rows.length === 0)
      return "No agents reported";
    const count = props.snapshot.rows.length;
    const attention = props.snapshot.rows.filter(
      (row) =>
        !stale(row) && (row.attention || row.activity === "waiting" || row.activity === "failed"),
    ).length;
    const working = props.snapshot.rows.filter(
      (row) => !stale(row) && row.activity === "running",
    ).length;
    return `${count} observed ${count === 1 ? "agent" : "agents"} · ${attention} ${attention === 1 ? "needs" : "need"} attention · ${working} working`;
  };
  const coverage = () =>
    `Scope: ${props.snapshot.observedSessions} of ${props.snapshot.totalSessions} sessions observed${props.snapshot.phase === "partial" ? " · partial" : ""}${props.snapshot.loadingSessions ? ` · ${props.snapshot.loadingSessions} loading` : ""}${props.snapshot.unavailableSessions ? ` · ${props.snapshot.unavailableSessions} unavailable` : ""}${props.snapshot.truncatedSessions ? ` · ${props.snapshot.truncatedSessions} not loaded` : ""}`;
  const footer = () => {
    if (props.snapshot.note) return props.snapshot.note;
    if (props.query && props.snapshot.rows.length === 0)
      return "Search covers loaded observations · Esc clears search";
    if (props.snapshot.rows.length === 0) {
      if (props.snapshot.phase === "live")
        return "Observed sessions have no agent entries. F2 opens terminals.";
      if (props.snapshot.phase === "unavailable")
        return "Observation unavailable; this is not an empty fleet.";
      return "Waiting for session observations. F2 opens terminals.";
    }
    if (visibleCount() === 0) return "Enlarge the terminal to view agents.";
    const selected = props.snapshot.rows.find((row) => row.key === props.selection.selectedKey);
    if (selected && stale(selected))
      return `${[selected.machineLabel, selected.serverLabel, selected.sessionName].filter(Boolean).join(" / ")} · last observed; waiting for fresh signals`;
    if (selected?.machineLabel || (width() < 44 && selected))
      return `${[selected?.machineLabel, selected?.serverLabel, selected?.sessionName].filter(Boolean).join(" / ")} · Enter open`;
    return `${offset() + 1}–${Math.min(props.snapshot.rows.length, offset() + visibleCount())} of ${props.snapshot.rows.length} · ↑↓ select · Enter open`;
  };
  useKeyboardRoute((event) => {
    if (!props.inputActive || event.eventType !== "press" || event.ctrl || event.meta) return false;
    const key = event.name.toLowerCase();
    const filter =
      !editing() &&
      (key === HOME_ACTIONS.machine.key
        ? props.onCycleMachine
        : key === HOME_ACTIONS.attention.key
          ? props.onToggleAttention
          : key === HOME_ACTIONS.working.key && props.onSetActivityFilter
            ? () => props.onSetActivityFilter?.("working")
            : key === HOME_ACTIONS.all.key && props.onSetActivityFilter
              ? () => props.onSetActivityFilter?.("all")
              : undefined);
    if (filter) {
      event.preventDefault();
      event.stopPropagation();
      filter();
      return true;
    }
    const retry =
      !editing() &&
      key === "r" &&
      (props.snapshot.phase === "unavailable" || props.snapshot.unavailableSessions > 0) &&
      props.onRetry;
    const more =
      !editing() && key === "m" && props.snapshot.truncatedSessions > 0 && props.onLoadMore;
    const recovery = retry || more;
    if (recovery) {
      event.preventDefault();
      event.stopPropagation();
      recovery();
      return true;
    }
    const delta = (
      {
        up: -1,
        down: 1,
        pageup: -Math.max(1, visibleCount()),
        pagedown: Math.max(1, visibleCount()),
        home: -Infinity,
        end: Infinity,
      } as Record<string, number>
    )[key];
    if (delta === undefined || props.snapshot.rows.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    props.onMove(delta);
    return true;
  });
  return (
    <box
      position="relative"
      width={width()}
      height={
        props.fitContent && props.snapshot.rows.length > 0
          ? height() - (visibleCount() - visible().length) * rowHeight()
          : height()
      }
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      onMouseScroll={(event) => {
        if (!props.inputActive) return;
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        event.preventDefault();
        event.stopPropagation();
        props.onMove(direction === "up" ? -1 : 1);
      }}
      onMouseOut={() => setHovered(null)}
    >
      <box height={searchRows()} flexShrink={0} />
      <Show when={!compact()}>
        <box width={width()} height={1} flexShrink={0} flexDirection="row">
          <Show when={props.snapshot.phase === "loading" || props.snapshot.loadingSessions > 0}>
            <ActivityIndicator theme={props.theme} active={props.inputActive} />
          </Show>
          <text height={1} flexGrow={1} fg={props.theme.roles.text.muted}>
            {clipTerminal(title(), width())}
          </text>
        </box>
      </Show>
      <Show when={!compact()}>
        <box
          width={width()}
          height={filterRows()}
          flexShrink={0}
          flexDirection={filterRows() > 1 ? "column" : "row"}
          overflow="hidden"
        >
          <KeyHint
            theme={props.theme}
            keys={HOME_ACTIONS.machine.keys}
            label={props.filterLabel?.split(" · ")[0] ?? "All machines"}
            width={
              props.onSetActivityFilter && filterRows() === 1
                ? Math.max(1, width() - 47)
                : props.onSetActivityFilter
                  ? Math.min(width(), 28)
                  : Math.max(1, Math.min(28, width() - 16))
            }
            quiet
            button
            onPress={() => {
              if (props.inputActive) props.onCycleMachine?.();
            }}
          />
          <box
            height={1}
            flexShrink={0}
            flexDirection="row"
            overflow="hidden"
            width={Math.min(width(), 47)}
          >
            <Show
              when={props.onSetActivityFilter}
              fallback={
                <KeyHint
                  theme={props.theme}
                  keys={HOME_ACTIONS.attention.keys}
                  label="Attention"
                  quiet
                  button
                  onPress={() => {
                    if (props.inputActive) props.onToggleAttention?.();
                  }}
                />
              }
            >
              <For each={HOME_ACTIVITY_ACTIONS}>
                {(filter) => (
                  <KeyHint
                    theme={props.theme}
                    keys={filter.keys}
                    label={
                      filter.value === "attention" && width() < 47 ? "Attention" : filter.label
                    }
                    quiet
                    button
                    selected={(props.activityFilter ?? "all") === filter.value}
                    onPress={() => {
                      if (props.inputActive) props.onSetActivityFilter?.(filter.value);
                    }}
                  />
                )}
              </For>
            </Show>
          </box>
        </box>
      </Show>
      <Show
        when={props.snapshot.rows.length > 0}
        fallback={
          <box
            height={Math.max(0, visibleCount() * rowHeight() + 1)}
            flexShrink={0}
            flexDirection="column"
            overflow="hidden"
          >
            <Show when={props.snapshot.phase === "live" && !props.query}>
              <text height={1} width={width()} fg={props.theme.roles.text.primary}>
                {clipTerminal(
                  filtered() ? "No agents match these filters" : "Your next session starts here",
                  width(),
                )}
              </text>
              <text height={1} width={width()} fg={props.theme.roles.text.muted}>
                {clipTerminal(
                  filtered()
                    ? "Choose All or change the machine filter to see more agents."
                    : "Open terminals, or use Commands to connect a machine.",
                  width(),
                )}
              </text>
            </Show>
          </box>
        }
      >
        <box height={compact() ? 0 : 1} flexShrink={0} />
        <box
          height={(props.fitContent ? visible().length : visibleCount()) * rowHeight()}
          width={width()}
          flexShrink={0}
          flexDirection="column"
          overflow="hidden"
        >
          <For each={keys()}>
            {(key) => {
              const row = () => byKey().get(key)!;
              return (
                <box
                  height={rowHeight()}
                  width={width()}
                  flexShrink={0}
                  onMouseOver={() => setHovered(key)}
                  onMouseMove={() => setHovered(key)}
                >
                  <AgentRow
                    surface="canvas"
                    theme={props.theme}
                    id={`home-agent:${key}`}
                    name={row().name}
                    context={[row().machineLabel, row().serverLabel, row().sessionName]
                      .filter(Boolean)
                      .join(" · ")}
                    width={width()}
                    compact={rowHeight() === 1}
                    interaction={props.interactionForAgent?.(row())}
                    paneName={props.paneName}
                    activity={row().activity}
                    attention={row().attention}
                    unavailable={row().paneId === null || stale(row())}
                    selected={props.selection.selectedKey === key}
                    focused={props.inputActive && !editing() && props.selection.selectedKey === key}
                    hovered={hovered() === key}
                    onOpen={(source) => {
                      if (!props.inputActive || row().paneId === null || stale(row())) return;
                      props.onSelect(key);
                      props.onOpen(row(), source);
                    }}
                  />
                </box>
              );
            }}
          </For>
        </box>
      </Show>
      <Show when={props.onQueryChange}>
        {(onQueryChange) => (
          <box position="absolute" top={0} left={0} width={width()} height={1}>
            <HomeAgentSearch
              theme={props.theme}
              width={width()}
              query={props.query ?? ""}
              active={props.inputActive}
              onChange={onQueryChange()}
              onEdit={(event) => {
                const action = applicationPaneRenameKeyAction(event, props.query ?? "");
                if (action.kind === "update") onQueryChange()(action.value);
              }}
              onPaste={(bytes) =>
                onQueryChange()(applicationPaneRenamePaste(props.query ?? "", bytes))
              }
              onEditing={setEditing}
              onSubmit={() => openSelected()}
            />
          </box>
        )}
      </Show>
      <text width={width()} height={1} flexShrink={0} fg={props.theme.roles.text.muted}>
        {clipTerminal(coverage(), width())}
      </text>
      <Show when={!compact()}>
        <box width={width()} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
          <text
            width={Math.min(
              Math.max(0, width() - (footer().endsWith("Enter open") && width() >= 20 ? 12 : 0)),
              terminalDisplayWidth(footer().replace(/ Enter open$/u, "")),
            )}
            fg={props.theme.roles.text.muted}
          >
            {clipTerminal(footer().replace(/ Enter open$/u, ""), width())}
          </text>
          <Show when={footer().endsWith("Enter open") && width() >= 20}>
            <KeyHint
              theme={props.theme}
              keys={HOME_ACTIONS.open.keys}
              label={HOME_ACTIONS.open.label}
              quiet
              button
              onPress={() => openSelected("mouse")}
            />
          </Show>
        </box>
      </Show>
      <Show when={showRecovery()}>
        <box height={1} width={width()} flexShrink={0} flexDirection="row" gap={1}>
          <Show
            when={
              (props.snapshot.phase === "unavailable" || props.snapshot.unavailableSessions > 0) &&
              props.onRetry
            }
          >
            {(retry) => (
              <TuiButton
                theme={props.theme}
                label="Retry"
                shortcut="r"
                size="compact"
                width={Math.min(width(), 9)}
                onPress={() => {
                  if (props.inputActive) retry()();
                }}
              />
            )}
          </Show>
          <Show when={props.snapshot.truncatedSessions > 0 && props.onLoadMore}>
            {(loadMore) => (
              <TuiButton
                theme={props.theme}
                label="Load more"
                shortcut="m"
                size="compact"
                width={Math.min(
                  Math.max(
                    0,
                    width() -
                      (props.onRetry &&
                      (props.snapshot.unavailableSessions || props.snapshot.phase === "unavailable")
                        ? 10
                        : 0),
                  ),
                  13,
                )}
                onPress={() => {
                  if (props.inputActive) loadMore()();
                }}
              />
            )}
          </Show>
        </box>
      </Show>
    </box>
  );
}
