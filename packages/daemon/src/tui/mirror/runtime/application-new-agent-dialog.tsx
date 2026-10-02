/* @jsxImportSource @opentui/solid */
import { Dialog } from "../ui/dialog.tsx";
import { TuiButton } from "../ui/button.tsx";
import { clipTerminal } from "../terminal-text.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type {
  createApplicationNewAgentOwner,
  NewAgentDraft,
} from "./application-new-agent-owner.ts";

export function ApplicationNewAgentDialog(props: {
  draft: NewAgentDraft;
  owner: ReturnType<typeof createApplicationNewAgentOwner>;
  width: number;
  height: number;
  theme: SemanticThemeSnapshot;
  active: boolean;
  zIndex: number;
}) {
  const width = () => Math.max(1, Math.min(64, props.width - 4));
  const textWidth = () => Math.max(1, width() - 6);
  return (
    <Dialog
      theme={props.theme}
      viewportWidth={props.width}
      viewportHeight={props.height}
      width={width()}
      height={Math.min(13, props.height)}
      title="New agent"
      footer="Type a name · Tab harness · Enter create · Esc cancel"
      active={props.active}
      zIndex={props.zIndex}
      onDismiss={props.owner.cancel}
    >
      <text
        height={1}
        fg={props.theme.roles.text.muted}
        content={clipTerminal(`Workspace  ${props.draft.workspace}`, textWidth())}
      />
      <text
        height={1}
        fg={props.theme.roles.text.primary}
        content={clipTerminal(
          `Name       ${props.draft.name || "Architect, Reviewer…"}${props.draft.name ? " ▏" : ""}`,
          textWidth(),
        )}
      />
      <box height={1} flexDirection="row" gap={1}>
        <text fg={props.theme.roles.text.muted}>Harness </text>
        <TuiButton
          theme={props.theme}
          label="Claude Code"
          size="compact"
          variant={props.draft.harness === "claude" ? "primary" : "secondary"}
          disabled={props.owner.busy()}
          onPress={() => props.owner.harness("claude")}
        />
        <TuiButton
          theme={props.theme}
          label="Codex"
          size="compact"
          variant={props.draft.harness === "codex" ? "primary" : "secondary"}
          disabled={props.owner.busy()}
          onPress={() => props.owner.harness("codex")}
        />
      </box>
      <text height={1} fg={props.theme.roles.text.muted}>
        New window · workspace directory
      </text>
      <text height={1} fg={props.theme.roles.text.muted}>
        Creates an independent agent with this display name.
      </text>
      <text
        height={1}
        fg={props.theme.roles.text.primary}
        content={clipTerminal(props.owner.error() ?? "", textWidth())}
      />
      <box height={1} flexDirection="row" gap={1}>
        <TuiButton
          theme={props.theme}
          label={props.owner.busy() ? "Creating…" : "Create agent"}
          size="compact"
          variant="primary"
          disabled={props.owner.busy() || !!props.owner.error() || !props.draft.name.trim()}
          onPress={props.owner.submit}
        />
        <TuiButton
          theme={props.theme}
          label="Cancel"
          size="compact"
          disabled={props.owner.busy()}
          onPress={props.owner.cancel}
        />
      </box>
    </Dialog>
  );
}
