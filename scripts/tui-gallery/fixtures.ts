import type {
  HomeAgentRow,
  HomeAgentSnapshot,
} from "../../packages/daemon/src/tui/mirror/runtime/application-home-agents.ts";
import type { ApplicationMachineGroup } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-sidebar.tsx";

export const GALLERY_STATES = [
  "mixed",
  "busy",
  "attention",
  "offline",
  "empty",
  "long labels",
] as const;
export type GalleryState = (typeof GALLERY_STATES)[number];
export function galleryAgents(state: GalleryState): HomeAgentSnapshot {
  const names =
    state === "long labels"
      ? [
          "分析 Café — implementation with a very long name",
          "Documentation and compatibility review across machines",
        ]
      : ["quiet-otter", "bright-panda", "release-review"];
  const rows: HomeAgentRow[] =
    state === "empty"
      ? []
      : names.map((name, i) => ({
          key: `fixture-${i}`,
          sessionKey: `session-${i}`,
          sessionName: i === 1 ? "docs" : "tmux-ide",
          liveSessionId: `$${i}`,
          daemonInstanceId: "fixture-daemon",
          agentId: `agent-${i}`,
          paneId: `pane.${i}`,
          name,
          harness: i === 1 ? "claude" : "codex",
          activity:
            state === "offline"
              ? "disconnected"
              : state === "attention"
                ? "waiting"
                : state === "busy"
                  ? "running"
                  : i === 0
                    ? "waiting"
                    : i === 1
                      ? "running"
                      : "complete",
          attention: state === "attention" || (state === "mixed" && i === 0),
          disabled: state === "offline",
          projectName: "tmux-ide",
          machineId: i === 1 ? "spark" : "local",
          machineLabel: i === 1 ? "Spark (fixture)" : "Local (fixture)",
        }));
  return {
    phase: state === "offline" ? "unavailable" : "live",
    rows,
    observedSessions: state === "empty" ? 0 : 3,
    totalSessions: state === "empty" ? 0 : 3,
    loadingSessions: 0,
    unavailableSessions: state === "offline" ? 3 : 0,
    truncatedSessions: 0,
    refreshingSessionKeys: [],
    unavailableSessionKeys: state === "offline" ? rows.map((r) => r.sessionKey) : [],
    note: state === "offline" ? "Fixture machines disconnected" : null,
  };
}
export function galleryMachines(state: GalleryState): ApplicationMachineGroup[] {
  if (state === "empty") return [];
  return ["local", "spark"].map((id) => ({
    id,
    label:
      state === "long labels"
        ? `${id} — very long machine name for clipping`
        : id === "local"
          ? "Local (fixture)"
          : "Spark (fixture)",
    state: state === "offline" ? "disconnected" : "ready",
    sessions: [
      {
        id: `${id}-session`,
        name: id === "spark" ? "docs" : "tmux-ide",
        paneCount: 3,
        disabled: state === "offline",
      },
    ],
    agentsAvailable: true,
    agents: galleryAgents(state)
      .rows.filter((r) => r.machineId === id)
      .map((r) => ({
        id: r.agentId,
        name: r.name,
        sessionName: r.sessionName,
        paneId: r.paneId,
        activity: r.activity,
        attention: r.attention,
        disabled: r.disabled,
      })),
  }));
}
