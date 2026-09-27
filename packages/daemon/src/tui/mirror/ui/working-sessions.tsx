/* @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { SessionRow, type SessionRowModel } from "./session-row.tsx";
import { useKeyboardRoute } from "./keyboard-router.tsx";

/** Bounded working-set list, independent of fleet discovery and terminal ownership. */
export function WorkingSessions(props: {
  theme: SemanticThemeSnapshot;
  rows: readonly SessionRowModel[];
  width: number;
  height: number;
  focused: boolean;
  onFocus?: () => void;
  onOpen: (key: string) => void;
  onClose?: (key: string) => void;
}) {
  const [selected, setSelected] = createSignal<string | null>(null);
  const index = () =>
    Math.max(
      0,
      props.rows.findIndex((row) => row.key === selected()),
    );
  const capacity = () => Math.max(0, Math.floor((props.height - 1) / 3));
  const start = () => Math.max(0, index() - capacity() + 1);
  const visible = () => props.rows.slice(start(), start() + capacity()).map((row) => row.key);
  createEffect(() => {
    if (!props.rows.some((row) => row.key === selected()))
      setSelected((props.rows.find((row) => row.active) ?? props.rows[0])?.key ?? null);
    if (!props.focused)
      setSelected((props.rows.find((row) => row.active) ?? props.rows[index()])?.key ?? null);
  });
  const open = (key: string) => {
    setSelected(key);
    props.onFocus?.();
    if (props.rows.find((row) => row.key === key)?.available) props.onOpen(key);
  };
  useKeyboardRoute((event) => {
    if (!props.focused || event.eventType !== "press" || event.ctrl || event.meta) return false;
    const key = event.name.toLowerCase();
    if (!["up", "down", "j", "k", "home", "end", "enter", "return", "space"].includes(key))
      return false;
    event.preventDefault();
    event.stopPropagation();
    if (!props.rows.length || !capacity()) return true;
    if (["enter", "return", "space"].includes(key)) open(props.rows[index()]!.key);
    else {
      const next =
        key === "home"
          ? 0
          : key === "end"
            ? props.rows.length - 1
            : Math.max(
                0,
                Math.min(props.rows.length - 1, index() + (["up", "k"].includes(key) ? -1 : 1)),
              );
      setSelected(props.rows[next]!.key);
    }
    return true;
  });
  return (
    <box
      width={props.width}
      height={props.height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
    >
      <text height={1} fg={props.theme.roles.text.secondary}>
        {props.focused ? <strong> Working sessions</strong> : " Working sessions"}
      </text>
      <Show
        when={props.rows.length}
        fallback={<text fg={props.theme.roles.text.muted}> No working sessions yet.</text>}
      >
        <For each={visible()}>
          {(key) => {
            const row = createMemo<SessionRowModel>(
              (previous) => props.rows.find((row) => row.key === key) ?? previous,
              props.rows.find((row) => row.key === key)!,
            );
            return (
              <box height={3} flexShrink={0} flexDirection="column">
                <SessionRow
                  theme={props.theme}
                  row={row()}
                  width={props.width}
                  selected={props.focused ? selected() === key : row().active}
                  onOpen={() => open(key)}
                  onClose={props.onClose ? () => props.onClose?.(key) : undefined}
                />
              </box>
            );
          }}
        </For>
      </Show>
    </box>
  );
}
