/* @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { INTERACTION_PRESENCE_MS } from "@tmux-ide/core";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { Badge } from "./badge.tsx";
import { TuiButton } from "./button.tsx";
import { createAgentStatusMarker } from "./agent-status-marker.ts";
import { OverlayFrame } from "./overlay-frame.tsx";
import { useKeyboardRoute, usePasteRoute } from "./keyboard-router.tsx";
import {
  paneInteractionPresentation,
  type PaneInteractionEvent,
} from "./pane-interaction-presentation.ts";

export interface PaneInteractionProps {
  theme: SemanticThemeSnapshot;
  event: PaneInteractionEvent;
  paneName?: (id: string) => string | undefined;
  width: number;
  onDetails?: () => void;
}
export function createPaneInteractionMarker(
  event: () => PaneInteractionEvent | undefined,
  theme: () => SemanticThemeSnapshot,
) {
  const [animate, setAnimate] = createSignal(false);
  createEffect(() => {
    const currentEvent = event();
    setAnimate(false);
    if (!currentEvent || currentEvent.phase !== "accepted" || theme().accessibility.reducedMotion)
      return;
    const age = Date.now() - Date.parse(currentEvent.at);
    if (!Number.isFinite(age) || age < 0 || age >= INTERACTION_PRESENCE_MS) return;
    // Fast operations never acquire the spinner; old history never looks live.
    const start = setTimeout(() => setAnimate(true), Math.max(0, 150 - age));
    const end = setTimeout(() => setAnimate(false), INTERACTION_PRESENCE_MS - age);
    onCleanup(() => {
      clearTimeout(start);
      clearTimeout(end);
    });
  });
  const marker = createAgentStatusMarker({
    theme: () => theme(),
    status: () => (animate() ? "running" : undefined),
  });
  return () => {
    const current = event();
    if (!current) return "";
    const value = paneInteractionPresentation(current);
    return value.failed ? "!" : value.pending ? (animate() ? marker() : "↳") : "✓";
  };
}

/** The same receipt vocabulary and shared animation clock in chrome and Home. */
export function PaneInteraction(props: PaneInteractionProps) {
  const value = () => paneInteractionPresentation(props.event, props.paneName);
  const marker = createPaneInteractionMarker(
    () => props.event,
    () => props.theme,
  );
  const detailsWidth = () => (props.onDetails && props.width >= 32 ? 9 : 0);
  return (
    <box width={props.width} height={1} flexShrink={0} flexDirection="row">
      <Badge
        theme={props.theme}
        width={Math.max(1, props.width - detailsWidth())}
        label={value().label}
        marker={marker()}
        tone={value().failed ? "warning" : value().pending ? "accent" : "done"}
      />
      <Show when={detailsWidth()}>
        <TuiButton
          theme={props.theme}
          label="Details"
          size="compact"
          width={9}
          onPress={props.onDetails}
        />
      </Show>
    </box>
  );
}

export function PaneInteractionDetails(
  props: PaneInteractionProps & {
    viewportWidth: number;
    viewportHeight: number;
    viewportOrigin?: { x: number; y: number };
    onDismiss: () => void;
  },
) {
  const value = () => paneInteractionPresentation(props.event, props.paneName);
  useKeyboardRoute((event) => {
    if (event.eventType === "press" && event.name === "escape") props.onDismiss();
    return true;
  });
  usePasteRoute(() => true);
  return (
    <OverlayFrame
      theme={props.theme}
      viewportWidth={props.viewportWidth}
      viewportHeight={props.viewportHeight}
      viewportOrigin={props.viewportOrigin}
      width={68}
      height={19}
      title="Pane interaction"
      surface
      modal
      onDismiss={props.onDismiss}
    >
      <scrollbox flexGrow={1}>
        <box flexDirection="column" gap={1}>
          <text fg={props.theme.roles.text.primary}>
            <strong>{value().phase}</strong>
          </text>
          <text fg={props.theme.roles.text.secondary}>{value().explanation}</text>
          <text fg={props.theme.roles.text.muted}>From</text>
          <text fg={props.theme.roles.text.primary}>{value().source}</text>
          <text fg={props.theme.roles.text.muted}>To</text>
          <text fg={props.theme.roles.text.primary}>{value().target}</text>
          <text fg={props.theme.roles.text.secondary}>{props.event.at}</text>
          <TuiButton theme={props.theme} label="Close" shortcut="Esc" onPress={props.onDismiss} />
        </box>
      </scrollbox>
    </OverlayFrame>
  );
}
