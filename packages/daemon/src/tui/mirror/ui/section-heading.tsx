/* @jsxImportSource @opentui/solid */
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";

export function SectionHeading(props: {
  theme: SemanticThemeSnapshot;
  title: string;
  width: number;
}) {
  return (
    <text height={1} width={props.width} flexShrink={0} fg={props.theme.roles.text.primary}>
      <strong>{clipTerminal(props.title, props.width)}</strong>
    </text>
  );
}
