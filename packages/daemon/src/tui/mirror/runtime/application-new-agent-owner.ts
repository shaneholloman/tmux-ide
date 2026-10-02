import { createSignal } from "solid-js";
import {
  applicationPaneRenameKeyAction,
  applicationPaneRenamePaste,
} from "./application-pane-rename-input.ts";

export interface NewAgentDraft {
  readonly name: string;
  readonly harness: "claude" | "codex";
  readonly workspace: string;
}

/** Owns one reviewed workspace target; reconnects never retarget a launch. */
export function createApplicationNewAgentOwner(options: {
  targetKey: () => string;
  workspace: () => string | null;
  create: (draft: NewAgentDraft) => Promise<string>;
  setNote: (note: string | null) => void;
}) {
  const [draft, setDraft] = createSignal<NewAgentDraft | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let target = "";
  const cancel = () => {
    if (!busy()) setDraft(null);
  };
  const submit = () => {
    const current = draft();
    if (!current || !current.name.trim() || busy() || error()) return;
    if (target !== options.targetKey()) {
      setError("Workspace changed. Close this dialog and open New agent again.");
      return;
    }
    setBusy(true);
    const expectedTarget = target;
    void Promise.resolve()
      .then(() => {
        if (options.targetKey() !== expectedTarget) throw new Error("Workspace changed");
        return options.create({ ...current, name: current.name.trim() });
      })
      .then((message) => {
        options.setNote(message);
        setDraft(null);
      })
      .catch(() => {
        setError("Creation was not confirmed. Check the workspace before trying again.");
      })
      .finally(() => setBusy(false));
  };
  const harness = (value: NewAgentDraft["harness"]) => {
    const current = draft();
    if (current && !busy()) setDraft({ ...current, harness: value });
  };
  return {
    draft,
    busy,
    error,
    cancel,
    submit,
    harness,
    begin() {
      const workspace = options.workspace();
      if (!workspace || busy()) return;
      target = options.targetKey();
      setError(null);
      setDraft({ name: "", harness: "claude", workspace });
    },
    handleKey(event: Parameters<typeof applicationPaneRenameKeyAction>[0]) {
      const current = draft();
      if (!current) return false;
      if (busy()) return true;
      if (event.name.toLowerCase() === "tab" && event.eventType !== "release") {
        harness(current.harness === "claude" ? "codex" : "claude");
        return true;
      }
      const action = applicationPaneRenameKeyAction(event, current.name);
      if (action.kind === "cancel") cancel();
      else if (action.kind === "submit") submit();
      else if (action.kind === "update") setDraft({ ...current, name: action.value });
      return true;
    },
    handlePaste(bytes: Uint8Array) {
      const current = draft();
      if (!current) return false;
      if (!busy()) setDraft({ ...current, name: applicationPaneRenamePaste(current.name, bytes) });
      return true;
    },
  };
}
