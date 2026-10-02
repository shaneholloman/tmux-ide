import type { AgentActivity } from "@tmux-ide/contracts";

/** Observed facts only. Pane modes belong to a view, never to the agent lifecycle. */
export interface StatusFacts {
  activity?: AgentActivity;
  attention?: boolean;
  unavailable?: boolean;
  connection?: string;
  scrollback?: boolean;
  expanded?: boolean;
}
export interface StatusPresentation {
  label: string;
  tone: "working" | "blocked" | "done" | "idle" | "unknown";
  activity?: AgentActivity;
  action?: "back-to-live" | "restore";
}

/** Availability > input capability > urgent activity > local mode > routine activity. No output inference. */
export function statusPresentation(facts: StatusFacts): StatusPresentation | undefined {
  if (facts.unavailable) return { label: "Unavailable", tone: "unknown" };
  if (facts.connection && !["live", "read-only"].includes(facts.connection)) {
    return {
      label:
        facts.connection === "connecting"
          ? "Connecting…"
          : facts.connection === "recovering" ||
              facts.connection === "reconnecting" ||
              facts.connection === "rebinding"
            ? "Reconnecting…"
            : facts.connection === "unavailable" || facts.connection === "disposed"
              ? "Unavailable"
              : "Disconnected",
      tone: "unknown",
    };
  }
  if (facts.activity === "disconnected") return { label: "Unknown", tone: "unknown" };
  if (facts.connection === "read-only") return { label: "Read-only", tone: "unknown" };
  if (facts.activity === "failed") return { label: "Failed", tone: "blocked", activity: "failed" };
  if (facts.attention || facts.activity === "waiting")
    return { label: "Needs input", tone: "blocked", activity: "waiting" };
  if (facts.scrollback) return { label: "Scrollback", tone: "idle", action: "back-to-live" };
  if (facts.expanded) return { label: "Expanded", tone: "idle", action: "restore" };
  switch (facts.activity) {
    case "running":
      return { label: "Working", tone: "working", activity: "running" };
    case "complete":
      return { label: "Done", tone: "done", activity: "complete" };
    case "idle":
      return { label: "Idle", tone: "idle", activity: "idle" };
    default:
      return undefined;
  }
}
