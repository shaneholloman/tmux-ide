import { createHash } from "node:crypto";
import { PaneTeamMembershipSchemaZ, type PaneTeamMembership } from "@tmux-ide/contracts";

export const PANE_TEAM_OPTION = "@tmux_ide_team";

/** Pane-local metadata survives layout moves, but never a replacement process. */
export function manualPaneTeamStamp(name: string, pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid pane process");
  const team = PaneTeamMembershipSchemaZ.parse({
    id: `team.${createHash("sha256").update(name).digest("hex").slice(0, 32)}`,
    name,
    source: "manual",
  });
  return `v1.${Buffer.from(JSON.stringify({ version: 1, pid, team })).toString("base64url")}`;
}

export function readManualPaneTeam(
  raw: string | null | undefined,
  pid: number | null,
): PaneTeamMembership | undefined {
  if (!raw || raw.length > 2048 || !pid) return undefined;
  try {
    if (!/^v1\.[A-Za-z0-9_-]+$/u.test(raw)) return undefined;
    const value = JSON.parse(Buffer.from(raw.slice(3), "base64url").toString("utf8"));
    if (value.version !== 1 || value.pid !== pid) return undefined;
    const parsed = PaneTeamMembershipSchemaZ.safeParse(value.team);
    return parsed.success && parsed.data.source === "manual" ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
