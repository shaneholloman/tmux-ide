import { describe, it, expect } from "vitest";
import { applicationTeamKey, groupApplicationTeamRows } from "./application-team-groups.ts";
const team = { id: "team.1234567890123456", name: "Review", source: "manual" as const };
const member = { team, machineId: "local", daemonInstanceId: "generation-one" };
describe("team grouping", () => {
  it("groups mixed harnesses independently of sessions and preserves member ordering", () => {
    const rows = [
      { id: "shell" },
      { ...member, id: "codex", sessionName: "a" },
      { id: "other" },
      { ...member, id: "claude", sessionName: "b" },
    ];
    expect(groupApplicationTeamRows(rows).map((row) => row.id)).toEqual([
      "codex",
      "claude",
      "shell",
      "other",
    ]);
  });
  it("does not merge equal labels across machines, servers, or generations", () => {
    const key = applicationTeamKey(member);
    expect(applicationTeamKey({ ...member, machineId: "spark" })).not.toBe(key);
    expect(applicationTeamKey({ ...member, daemonInstanceId: "generation-two" })).not.toBe(key);
    expect(
      applicationTeamKey({ ...member, team: { ...team, id: "team.9876543210987654" } }),
    ).not.toBe(key);
    expect(applicationTeamKey({ ...member, team: { ...team, source: "claude-code" } })).not.toBe(
      key,
    );
    expect(applicationTeamKey({})).toBeNull();
  });
});
