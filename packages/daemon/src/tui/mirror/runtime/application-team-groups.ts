import {
  paneTeamGroupKey,
  type PaneTeamMembership,
  type TmuxServerScope,
} from "@tmux-ide/contracts";

interface TeamRow {
  readonly team?: PaneTeamMembership;
  readonly machineId?: string;
  readonly server?: TmuxServerScope;
  readonly daemonInstanceId?: string;
}

export function applicationTeamKey(row: TeamRow): string | null {
  return row.team
    ? paneTeamGroupKey(
        row.team,
        row.machineId ?? "local",
        row.server?.serverId ?? "default",
        row.server?.generation ?? row.daemonInstanceId ?? "",
      )
    : null;
}

/** Group by membership, never by name, activity, or current tmux window. Stable within groups. */
export function groupApplicationTeamRows<T extends TeamRow>(rows: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const row of rows) {
    const key = applicationTeamKey(row);
    if (key === null) {
      ungrouped.push(row);
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flat().concat(ungrouped);
}
