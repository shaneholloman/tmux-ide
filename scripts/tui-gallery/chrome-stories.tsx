/* @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js";
import { PaneTitleBar } from "../../packages/daemon/src/tui/mirror/workspace/terminal-pane-header.tsx";
import { ContextStatusBar } from "../../packages/daemon/src/tui/mirror/shell-chrome-view.tsx";
import { shellChromeLayout } from "../../packages/daemon/src/tui/mirror/shell-chrome.ts";
import type { SemanticThemeSnapshot } from "../../packages/daemon/src/tui/mirror/theme.ts";
import { useKeyboardRoute } from "../../packages/daemon/src/tui/mirror/ui/keyboard-router.tsx";
import type { GalleryState } from "./fixtures.ts";

interface ChromeStoryProps {
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
  state: GalleryState;
  interacting: boolean;
  record: (action: string) => void;
}
export function PaneHeaderStory(props: ChromeStoryProps) {
  const [selected, setSelected] = createSignal(true);
  return (
    <box width={props.width} height={props.height} flexDirection="column">
      <PaneTitleBar
        theme={props.theme}
        paneId="pane.fixture"
        title={
          props.state === "long labels"
            ? "分析 Café — implementation with a very long pane title"
            : "Claude Code"
        }
        width={props.width}
        selected={selected()}
        terminalFocused={false}
        keyboardFocused={props.interacting}
        activity={
          props.state === "busy"
            ? "running"
            : props.state === "attention"
              ? "waiting"
              : props.state === "offline"
                ? "disconnected"
                : props.state === "empty"
                  ? undefined
                  : "complete"
        }
        attention={props.state === "attention"}
        menuAnchor={{ x: props.width - 1, y: 4 }}
        onSelectIntent={() => {
          setSelected((value) => !value);
          props.record("Select pane (simulated)");
        }}
        onMenuIntent={() => props.record("Pane menu (simulated)")}
      />
      <text fg={props.theme.colors.mutedForeground}>
        Fixture terminal body — title and menu use production hit targets.
      </text>
    </box>
  );
}
export function FooterStory(props: ChromeStoryProps) {
  useKeyboardRoute((event) => {
    if (!props.interacting || event.ctrl || event.meta) return false;
    const action = (
      { f5: "Commands", f6: "Sessions", f7: "Attention", f10: "Sidebar" } as Record<string, string>
    )[event.name];
    if (!action) return false;
    event.preventDefault();
    event.stopPropagation();
    props.record(`${action} (simulated)`);
    return true;
  });
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      justifyContent="space-between"
    >
      <text fg={props.theme.colors.mutedForeground}>
        Fixture workspace — footer buttons record simulated actions.
      </text>
      <ContextStatusBar
        theme={props.theme}
        layout={shellChromeLayout(props.width, props.height, 0)}
        project="tmux-ide"
        session="fixture"
        mode={props.state === "empty" ? "home" : "terminals"}
        notification={
          props.state === "attention"
            ? "Agent needs attention"
            : props.state === "long labels"
              ? "A deliberately long operation status to inspect clipping on narrow terminals"
              : null
        }
        transient={props.state === "busy" ? "Refreshing fixture" : null}
        connectionState={props.state === "offline" ? "disconnected" : "connected"}
        help="F5 Commands"
        onHelp={() => props.record("Commands (simulated)")}
        onFooterAction={(key) =>
          props.record(`${{ F6: "Sessions", F7: "Attention", F10: "Sidebar" }[key]} (simulated)`)
        }
      />
    </box>
  );
}
