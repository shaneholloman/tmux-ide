/* @jsxImportSource @opentui/solid */
import type { AgentActivity } from "@tmux-ide/contracts";
import { Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { NavigationRow } from "./navigation-row.tsx";
import { TuiButton } from "./button.tsx";
import { componentPalette } from "./state.ts";
import { createAgentStatusMarker } from "./agent-status-marker.ts";
import { UI_ICONS } from "./icons.ts";

export interface SessionRowModel {
  readonly key: string;
  readonly label: string;
  readonly hostLabel: string;
  readonly serverLabel?: string;
  readonly active: boolean;
  readonly available: boolean;
  readonly activity?: AgentActivity;
  readonly attention?: boolean;
  readonly unread?: boolean;
}
export function sessionRowStatus(row: SessionRowModel) {
  if (!row.available) return "offline";
  if (row.attention || row.activity === "waiting") return "needs input";
  if (row.activity === "failed") return "failed";
  if (row.activity === "running") return "working";
  if (row.unread) return "new result";
  if (!row.activity || row.activity === "disconnected") return "unknown";
  return "idle";
}
/** Shared two-line session identity. Pure presentation: opening/closing belongs to its owner. */
export function SessionRow(props: {
  theme: SemanticThemeSnapshot;
  row: SessionRowModel;
  width: number;
  selected?: boolean;
  focused?: boolean;
  onOpen: () => void;
  onClose?: () => void;
}) {
  const marker = createAgentStatusMarker({
    theme: () => props.theme,
    status: () => (sessionRowStatus(props.row) === "idle" ? "idle" : props.row.activity),
    attention: () => !!props.row.attention,
    unavailable: () => !props.row.available,
  });
  const tone = () => {
    const status = sessionRowStatus(props.row);
    return status === "needs input" || status === "failed"
      ? ("blocked" as const)
      : status === "working"
        ? ("working" as const)
        : status === "new result"
          ? ("done" as const)
          : ("neutral" as const);
  };
  const glyph = () =>
    !props.row.available
      ? UI_ICONS.offline
      : sessionRowStatus(props.row) === "new result"
        ? UI_ICONS.newResult
        : marker();
  const palette = () =>
    componentPalette(props.theme, {
      selected: props.selected,
      focused: props.focused,
      disabled: !props.row.available,
    });
  const detail = () =>
    `${props.row.hostLabel} · ${props.row.serverLabel ?? "default"}${props.row.active ? " · current" : ""}`;
  return (
    <box
      id={`session-row:${props.row.key}`}
      width={props.width}
      height={2}
      flexDirection="column"
      overflow="hidden"
    >
      <box height={1} flexDirection="row">
        <NavigationRow
          theme={props.theme}
          id={`fleet-tab:${props.row.key}`}
          width={Math.max(1, props.width - (props.onClose ? 3 : 0))}
          label={props.row.label}
          tone={tone()}
          marker={glyph()}
          detail={sessionRowStatus(props.row)}
          selected={props.selected}
          focused={props.focused}
          disabled={!props.row.available}
          onActivate={props.onOpen}
        />
        <Show when={props.onClose}>
          <TuiButton
            theme={props.theme}
            label={UI_ICONS.close}
            size="compact"
            width={3}
            onPress={props.onClose}
          />
        </Show>
      </box>
      <box
        height={1}
        backgroundColor={palette().background}
        onMouseDown={(event) => {
          if (event.button !== 0 || !props.row.available) return;
          event.preventDefault();
          event.stopPropagation();
          props.onOpen();
        }}
      >
        <text
          fg={props.selected || props.focused ? palette().foreground : props.theme.roles.text.muted}
        >
          {clipTerminal(`  ${detail()}`, props.width)}
        </text>
      </box>
    </box>
  );
}
