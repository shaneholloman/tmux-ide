/* @jsxImportSource @opentui/solid */
import { Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { TuiButton } from "./button.tsx";

/** Fixed-budget mode description and an explicit action, never terminal geometry. */
export function PaneModeControl(props: {
  theme: SemanticThemeSnapshot;
  width: number;
  scrollback: boolean;
  linesAboveLive?: number;
  onBackToLive?: () => void;
  onRestore?: () => void;
}) {
  const action = () => (props.scrollback ? "Back to live" : "Restore");
  const actionWidth = () => Math.min(props.width, terminalDisplayWidth(action()) + 2);
  const labelWidth = () => Math.max(0, props.width - actionWidth());
  const label = () =>
    props.scrollback
      ? props.linesAboveLive && labelWidth() >= 28
        ? ` ↑ Scrollback · ${props.linesAboveLive} lines up `
        : " Scrollback "
      : " Expanded ";
  return (
    <box
      width={props.width}
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={props.theme.roles.surfaces.panel}
    >
      <Show when={labelWidth() > 0}>
        <text width={labelWidth()} fg={props.theme.roles.text.secondary}>
          {clipTerminal(label(), labelWidth())}
        </text>
      </Show>
      <TuiButton
        theme={props.theme}
        label={action()}
        size="compact"
        width={actionWidth()}
        onPress={() => (props.scrollback ? props.onBackToLive?.() : props.onRestore?.())}
      />
    </box>
  );
}
