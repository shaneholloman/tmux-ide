/* @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";

/** Shared input surface; input ownership and keyboard routing remain with the caller. */
export function InputSurface(props: {
  theme: SemanticThemeSnapshot;
  width: number;
  active?: boolean;
  children: JSX.Element;
}) {
  return (
    <box
      width={props.width}
      height={1}
      flexShrink={0}
      flexDirection="row"
      overflow="hidden"
      backgroundColor={props.theme.roles.surfaces.panelRaised}
    >
      <text
        width={1}
        height={1}
        fg={props.active ? props.theme.roles.borders.focused : props.theme.roles.borders.subtle}
      >
        ┃
      </text>
      <box
        width={Math.max(0, props.width - 1)}
        paddingLeft={props.width >= 4 ? 1 : 0}
        paddingRight={props.width >= 4 ? 1 : 0}
        height={1}
        overflow="hidden"
      >
        {props.children}
      </box>
    </box>
  );
}
