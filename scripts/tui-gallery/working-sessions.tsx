/* @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../../packages/daemon/src/tui/mirror/theme.ts";
import {
  clipTerminal,
  terminalDisplayWidth,
} from "../../packages/daemon/src/tui/mirror/terminal-text.ts";
import { KeyHint } from "../../packages/daemon/src/tui/mirror/ui/key-hint.tsx";
import { useKeyboardRoute } from "../../packages/daemon/src/tui/mirror/ui/keyboard-router.tsx";
import type { GalleryState } from "./fixtures.ts";

/** Prototype-only data: unread results are independent of execution and attention. */
export function workingSessionFixtures(state: GalleryState) {
  if (state === "empty") return [];
  return ["tmux-ide", "prototyper", "documentation", "tmux-ide"].map((title, index) => ({
    key: `fixture-session-${index}`,
    title: state === "long labels" ? `${title} — 分析 Café and a long session name` : title,
    machine: index === 0 ? "Local" : "Spark",
    server: index === 1 || index === 3 ? "development" : "default",
    busy: state === "busy" || (state === "mixed" && index === 0),
    attention: state === "attention" || (state === "mixed" && index === 1),
    unread: (state === "mixed" || state === "long labels") && index === 2,
    connected: state !== "offline",
  }));
}

export function WorkingSessionsStory(props: {
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
  state: GalleryState;
  interacting: boolean;
  record: (value: string) => void;
}) {
  const rows = createMemo(() => workingSessionFixtures(props.state));
  const [selected, setSelected] = createSignal(0);
  const [active, setActive] = createSignal("fixture-session-0");
  const [seen, setSeen] = createSignal<ReadonlySet<string>>(new Set());
  const width = () => Math.min(props.width, 44);
  const capacity = () => Math.max(0, Math.floor((props.height - 5) / 3));
  const offset = () => Math.max(0, selected() - capacity() + 1);
  const visible = () => rows().slice(offset(), offset() + capacity());
  const browse = () => props.record("Browse all sessions (simulated)");
  const open = (index: number) => {
    const row = rows()[index];
    if (!row) return;
    setSelected(index);
    if (!row.connected) {
      props.record(`Unavailable: ${row.machine} · ${row.server} (simulated)`);
      return;
    }
    setActive(row.key);
    setSeen((previous) => new Set([...previous, row.key]));
    props.record(`Open ${row.title} · ${row.machine} · ${row.server} (simulated)`);
  };
  useKeyboardRoute((event) => {
    if (!props.interacting || event.eventType !== "press" || event.ctrl || event.meta) return false;
    const key = event.name.toLowerCase();
    if (key === "f6") browse();
    else if (key === "down" || key === "j")
      setSelected((i) => Math.max(0, Math.min(rows().length - 1, i + 1)));
    else if (key === "up" || key === "k") setSelected((i) => Math.max(0, i - 1));
    else if (key === "home") setSelected(0);
    else if (key === "end") setSelected(Math.max(0, rows().length - 1));
    else if ((key === "return" || key === "enter") && capacity() > 0) open(selected());
    else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  });
  const status = (row: ReturnType<typeof workingSessionFixtures>[number]) => {
    if (!row.connected) return { mark: "○", label: "offline", tone: props.theme.roles.text.muted };
    if (row.attention)
      return { mark: "!", label: "needs input", tone: props.theme.colors.status.blocked };
    if (row.busy) return { mark: "●", label: "working", tone: props.theme.roles.text.primary };
    if (row.unread && !seen().has(row.key))
      return { mark: "•", label: "new result", tone: props.theme.colors.status.done };
    return { mark: "○", label: "idle", tone: props.theme.roles.text.muted };
  };
  return (
    <box
      width={width()}
      height={props.height}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={props.theme.roles.surfaces.panel}
    >
      <text height={1} fg={props.theme.roles.text.primary}>
        <strong> Working sessions</strong>
      </text>
      <text height={1} fg={props.theme.roles.text.muted}>
        {clipTerminal(" Open tabs across your machines", width())}
      </text>
      <box height={1} />
      <box flexGrow={1} flexDirection="column" overflow="hidden">
        <Show
          when={rows().length > 0}
          fallback={<text fg={props.theme.roles.text.muted}> No working sessions yet.</text>}
        >
          <Show
            when={capacity() > 0}
            fallback={<text fg={props.theme.roles.text.muted}> More room needed · F6 browse</text>}
          >
            <For each={visible()}>
              {(row, position) => {
                const index = () => offset() + position();
                const focused = () => props.interacting && index() === selected();
                const highlighted = () => index() === selected();
                const background = () =>
                  highlighted()
                    ? props.theme.roles.selection.selection
                    : props.theme.roles.surfaces.panel;
                const foreground = () =>
                  highlighted()
                    ? props.theme.roles.selection.selectionText
                    : props.theme.roles.text.primary;
                const detail = () =>
                  `${row.machine} · ${row.server}${row.key === active() ? " · current" : ""}`;
                return (
                  <box height={3} flexShrink={0} flexDirection="column">
                    <box
                      height={2}
                      flexDirection="column"
                      backgroundColor={background()}
                      onMouseDown={(event) => {
                        if (event.button !== 0 || !props.interacting) return;
                        event.preventDefault();
                        event.stopPropagation();
                        open(index());
                      }}
                    >
                      <box height={1} flexDirection="row">
                        <text
                          width={3}
                          fg={highlighted() ? foreground() : status(row).tone}
                        >{` ${status(row).mark} `}</text>
                        <text
                          width={Math.max(1, width() - terminalDisplayWidth(status(row).label) - 5)}
                          fg={foreground()}
                          wrapMode="none"
                        >
                          {focused() ? (
                            <strong>
                              {clipTerminal(
                                row.title,
                                Math.max(1, width() - terminalDisplayWidth(status(row).label) - 5),
                              )}
                            </strong>
                          ) : (
                            clipTerminal(
                              row.title,
                              Math.max(1, width() - terminalDisplayWidth(status(row).label) - 5),
                            )
                          )}
                        </text>
                        <text
                          fg={highlighted() ? foreground() : status(row).tone}
                        >{` ${status(row).label} `}</text>
                      </box>
                      <text fg={highlighted() ? foreground() : props.theme.roles.text.muted}>
                        {clipTerminal(`   ${detail()}`, width())}
                      </text>
                    </box>
                  </box>
                );
              }}
            </For>
          </Show>
        </Show>
      </box>
      <text height={1} fg={props.theme.roles.text.muted}>
        {clipTerminal(
          rows().length
            ? ` ↑↓ choose · Enter open · ${selected() + 1}/${rows().length}`
            : " Find a session to add to your work",
          width(),
        )}
      </text>
      <KeyHint
        theme={props.theme}
        keys="F6"
        label="Browse all sessions"
        width={width()}
        quiet
        button
        onPress={() => {
          if (props.interacting) browse();
        }}
      />
    </box>
  );
}
