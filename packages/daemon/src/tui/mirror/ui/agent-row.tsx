/* @jsxImportSource @opentui/solid */
import type { AgentActivity } from "@tmux-ide/contracts";
import { Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { NavigationRow, type NavigationRowInputSource } from "./navigation-row.tsx";
import { createAgentStatusMarker } from "./agent-status-marker.ts";
import { componentPalette } from "./state.ts";

/** One agent identity and one state marker, shared by Home and fleet navigation. */
export function AgentRow(props: {
  theme: SemanticThemeSnapshot;
  id: string;
  name: string;
  context: string;
  activity: AgentActivity;
  attention?: boolean;
  unavailable?: boolean;
  width: number;
  compact?: boolean;
  surface?: "canvas" | "panel";
  selected?: boolean;
  focused?: boolean;
  hovered?: boolean;
  onOpen: (source: NavigationRowInputSource) => void;
}) {
  const marker = createAgentStatusMarker({
    theme: () => props.theme,
    status: () => props.activity,
    attention: () => !!props.attention,
    unavailable: () => !!props.unavailable,
  });
  const palette = () =>
    componentPalette(props.theme, {
      selected: props.selected,
      focused: props.focused,
      hovered: props.hovered,
      disabled: props.unavailable,
    });
  const background = () =>
    palette().state === "base" && props.surface === "canvas"
      ? props.theme.roles.surfaces.canvas
      : palette().background;
  const exceptional = () =>
    props.unavailable ? "unavailable" : props.activity === "disconnected" ? "unknown" : undefined;
  return (
    <box
      width={props.width}
      height={props.compact ? 1 : 2}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={background()}
      onMouseDown={(event) => {
        if (event.button !== 0 || props.unavailable) return;
        event.preventDefault();
        event.stopPropagation();
        props.onOpen("mouse");
      }}
    >
      <NavigationRow
        surface={props.surface}
        theme={props.theme}
        id={props.id}
        width={props.width}
        label={props.name}
        marker={
          props.activity === "idle" && !props.attention && !props.unavailable ? " " : marker()
        }
        detail={exceptional()}
        selected={props.selected}
        focused={props.focused}
        hovered={props.hovered}
        disabled={props.unavailable}
        tone={
          props.attention || props.activity === "waiting" || props.activity === "failed"
            ? "warning"
            : "neutral"
        }
        onActivate={props.onOpen}
      />
      <Show when={!props.compact}>
        <text
          height={1}
          width={props.width}
          fg={props.selected ? palette().foreground : props.theme.roles.text.muted}
        >
          {clipTerminal(`  ${props.context}`, props.width)}
        </text>
      </Show>
    </box>
  );
}
