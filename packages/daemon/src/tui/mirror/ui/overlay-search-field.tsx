/* @jsxImportSource @opentui/solid */
import { InputSurface } from "./input-surface.tsx";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminalEnd } from "../terminal-text.ts";

/** Search presentation only; the existing dialog owner handles editing and focus. */
export function OverlaySearchField(props: {
  theme: SemanticThemeSnapshot;
  width: number;
  query?: string;
  placeholder: string;
}) {
  const inset = () => (props.width >= 4 ? 1 : 0);
  return (
    <InputSurface theme={props.theme} width={props.width} active>
      <text
        height={1}
        width={Math.max(1, props.width - 1 - inset() * 2)}
        fg={props.query ? props.theme.roles.text.primary : props.theme.roles.text.muted}
        content={clipTerminalEnd(
          props.query ? `${props.query}▏` : props.placeholder,
          Math.max(1, props.width - 1 - inset() * 2),
        )}
      />
    </InputSurface>
  );
}
