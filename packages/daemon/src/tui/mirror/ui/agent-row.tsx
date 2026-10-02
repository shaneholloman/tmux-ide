import type { PaneInteractionEndpoint } from "./pane-interaction-presentation.ts";
import { createPaneInteractionMarker } from "./pane-interaction.tsx";
import {
  paneInteractionPresentation,
  type PaneInteractionEvent,
} from "./pane-interaction-presentation.ts";
/* @jsxImportSource @opentui/solid */
import type { AgentActivity, PaneTeamMembership } from "@tmux-ide/contracts";
import { Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { NavigationRow, type NavigationRowInputSource } from "./navigation-row.tsx";
import { createAgentStatusMarker } from "./agent-status-marker.ts";
import { statusPresentation } from "./status-presentation.ts";
import { componentPalette } from "./state.ts";

/** One agent identity and one state marker, shared by Home and fleet navigation. */
export function AgentRow(props: {
  theme: SemanticThemeSnapshot;
  id: string;
  name: string;
  team?: PaneTeamMembership;
  context: string;
  activity: AgentActivity;
  interaction?: PaneInteractionEvent;
  paneName?: (endpoint: PaneInteractionEndpoint) => string | undefined;
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
  const status = () => statusPresentation(props);
  const receipt = () =>
    !props.unavailable &&
    props.activity !== "disconnected" &&
    !props.attention &&
    props.activity !== "waiting" &&
    props.activity !== "failed" &&
    props.interaction
      ? paneInteractionPresentation(props.interaction, props.paneName)
      : undefined;
  const receiptMarker = createPaneInteractionMarker(
    () => (receipt() ? props.interaction : undefined),
    () => props.theme,
  );
  const marker = createAgentStatusMarker({
    theme: () => props.theme,
    status: () => (receipt() ? undefined : status()?.activity),
    attention: () => status()?.activity === "waiting",
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
        label={props.compact && props.team ? `${props.team.name} / ${props.name}` : props.name}
        marker={
          receipt()
            ? receiptMarker()
            : props.activity === "idle" && !props.attention && !props.unavailable
              ? " "
              : marker()
        }
        detail={
          props.width < 24
            ? undefined
            : receipt()
              ? clipTerminal(receipt()!.compactLabel, Math.max(0, props.width - 14))
              : status()?.label === "Idle"
                ? undefined
                : status()?.label
        }
        selected={props.selected}
        focused={props.focused}
        hovered={props.hovered}
        disabled={props.unavailable}
        tone={status()?.tone === "blocked" ? "warning" : "neutral"}
        onActivate={props.onOpen}
      />
      <Show when={!props.compact}>
        <text
          height={1}
          width={props.width}
          fg={props.selected ? palette().foreground : props.theme.roles.text.muted}
        >
          {clipTerminal(
            `  ${[props.team?.name, props.context].filter(Boolean).join(" · ")}`,
            props.width,
          )}
        </text>
      </Show>
    </box>
  );
}
