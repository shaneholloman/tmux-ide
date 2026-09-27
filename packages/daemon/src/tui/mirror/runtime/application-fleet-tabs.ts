import type { TmuxServerScope } from "@tmux-ide/contracts";
export interface FleetTabTarget {
  readonly key: string;
  readonly machineId: string;
  readonly liveSessionId: string;
  readonly server?: TmuxServerScope;
  readonly label: string;
  readonly hostLabel: string;
  readonly serverLabel?: string;
}
/** Retained targets, with at most one active terminal owner. Suspended tabs own no streams. */
export function createFleetTabs(options: {
  resolve(target: FleetTabTarget): FleetTabTarget | null;
  retireActive(): void;
  open(target: FleetTabTarget): Promise<boolean>;
  publish(): void;
  unavailable(): void;
}) {
  const tabs = new Map<string, FleetTabTarget>();
  const unread = new Set<string>();
  const observations = new Map<string, Map<string, string>>();
  let active: string | null = null;
  let pending: string | null = null;
  let epoch = 0;
  let disposed = false;
  return {
    snapshot: () => ({ tabs: [...tabs.values()], active, unread: [...unread] }),
    observe(key: string, agents: readonly { id: string; activity: string }[] | null) {
      if (disposed || !tabs.has(key)) return;
      if (!agents) {
        observations.delete(key);
        return;
      }
      const previous = observations.get(key);
      observations.set(key, new Map(agents.map((agent) => [agent.id, agent.activity])));
      if (
        active !== key &&
        !unread.has(key) &&
        agents.some(
          (agent) => agent.activity === "complete" && previous?.get(agent.id) === "running",
        )
      ) {
        unread.add(key);
        options.publish();
      }
    },
    remember(target: FleetTabTarget) {
      if (disposed) return;
      if (!tabs.has(target.key) && tabs.size >= 8) {
        const removable = [...tabs.keys()].find((key) => key !== active);
        if (removable) {
          tabs.delete(removable);
          unread.delete(removable);
          observations.delete(removable);
        }
      }
      tabs.set(target.key, Object.freeze({ ...target }));
      unread.delete(target.key);
      active = target.key;
      options.publish();
    },
    async activate(key: string) {
      const saved = tabs.get(key);
      if (disposed || !saved) return false;
      const target = options.resolve(saved);
      if (!target) {
        options.unavailable();
        return false;
      }
      const token = ++epoch;
      pending = key;
      options.retireActive();
      active = null;
      options.publish();
      const opened = await options.open(target).catch(() => false);
      if (disposed || token !== epoch || !tabs.has(key)) return false;
      pending = null;
      if (!opened) {
        options.unavailable();
        return false;
      }
      unread.delete(key);
      active = key;
      options.publish();
      return true;
    },
    close(key: string) {
      if (!tabs.has(key)) return;
      if (active === key || pending === key) {
        epoch++;
        options.retireActive();
        active = null;
        pending = null;
      }
      tabs.delete(key);
      unread.delete(key);
      observations.delete(key);
      options.publish();
    },
    suspend() {
      epoch++;
      active = null;
      pending = null;
      options.publish();
    },
    cancel() {
      epoch++;
    },
    dispose() {
      disposed = true;
      epoch++;
      tabs.clear();
      unread.clear();
      observations.clear();
      active = null;
    },
  };
}
