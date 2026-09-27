/* @jsxImportSource @opentui/solid */
import { createMemo, createSignal } from "solid-js";
import type { SemanticThemeSnapshot } from "../../packages/daemon/src/tui/mirror/theme.ts";
import { WorkingSessions } from "../../packages/daemon/src/tui/mirror/ui/working-sessions.tsx";
import { KeyHint } from "../../packages/daemon/src/tui/mirror/ui/key-hint.tsx";
import { useKeyboardRoute } from "../../packages/daemon/src/tui/mirror/ui/keyboard-router.tsx";
import type { GalleryState } from "./fixtures.ts";

/** Fixture data: unread results are independent of execution and attention. */
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
  const [active, setActive] = createSignal("fixture-session-0");
  const [seen, setSeen] = createSignal<ReadonlySet<string>>(new Set());
  const rows = createMemo(() =>
    workingSessionFixtures(props.state).map((row) => ({
      key: row.key,
      label: row.title,
      hostLabel: row.machine,
      serverLabel: row.server,
      active: row.key === active(),
      available: row.connected,
      activity: row.attention
        ? ("waiting" as const)
        : row.busy
          ? ("running" as const)
          : ("idle" as const),
      attention: row.attention,
      unread: row.unread && !seen().has(row.key),
    })),
  );
  const browse = () => props.record("Browse all sessions (simulated)");
  useKeyboardRoute((event) => {
    if (
      !props.interacting ||
      event.eventType !== "press" ||
      event.ctrl ||
      event.meta ||
      event.name !== "f6"
    )
      return false;
    event.preventDefault();
    event.stopPropagation();
    browse();
    return true;
  });
  return (
    <box width={Math.min(props.width, 44)} height={props.height} flexDirection="column">
      <WorkingSessions
        theme={props.theme}
        rows={rows()}
        width={Math.min(props.width, 44)}
        height={Math.max(1, props.height - 1)}
        focused={props.interacting}
        onOpen={(key) => {
          if (!props.interacting) return;
          const row = rows().find((row) => row.key === key)!;
          setActive(key);
          setSeen((previous) => new Set([...previous, key]));
          props.record(`Open ${row.label} · ${row.hostLabel} · ${row.serverLabel} (simulated)`);
        }}
      />
      <KeyHint
        theme={props.theme}
        keys="F6"
        label="Browse all sessions"
        width={Math.min(props.width, 44)}
        quiet
        button
        onPress={() => {
          if (props.interacting) browse();
        }}
      />
    </box>
  );
}
