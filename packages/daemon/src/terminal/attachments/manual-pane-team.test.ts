import { describe, it, expect } from "vitest";
import { manualPaneTeamStamp, readManualPaneTeam } from "./manual-pane-team.ts";
import { assignPaneTeam } from "../../pane-team.ts";

describe("explicit team membership", () => {
  it("preserves membership across layout moves but not replacement processes", () => {
    const stamp = manualPaneTeamStamp("Release crew", 42);
    expect(readManualPaneTeam(stamp, 42)?.name).toBe("Release crew");
    expect(readManualPaneTeam(stamp, 43)).toBeUndefined();
    expect(readManualPaneTeam(stamp, null)).toBeUndefined();
    expect(readManualPaneTeam("not json", 42)).toBeUndefined();
    expect(readManualPaneTeam("v1.invalid", 42)).toBeUndefined();
    const delimiterName = "a|tmux-ide-agent-field-v1|b";
    const encoded = manualPaneTeamStamp(delimiterName, 42);
    expect(encoded).not.toContain("|");
    expect(readManualPaneTeam(encoded, 42)?.name).toBe(delimiterName);
  });
  it("rejects invalid names rather than putting terminal controls into metadata", () => {
    for (const name of ["", " leading", "bad\nname", "x".repeat(81)])
      expect(() => manualPaneTeamStamp(name, 42)).toThrow();
  });
  it("targets only the explicit socket and exact pane, without sending agent input", () => {
    const calls: string[][] = [];
    assignPaneTeam({ paneId: "%7", name: "Release crew", socketPath: "/tmp/test.sock" }, (args) => {
      calls.push(args);
      return "42\n";
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "-S",
      "/tmp/test.sock",
      "display-message",
      "-p",
      "-t",
      "%7",
      "#{pane_pid}",
    ]);
    expect(calls[1]!.slice(0, -1)).toEqual([
      "-S",
      "/tmp/test.sock",
      "set-option",
      "-p",
      "-t",
      "%7",
      "@tmux_ide_team",
    ]);
    expect(readManualPaneTeam(calls[1]!.at(-1), 42)?.name).toBe("Release crew");
    expect(() =>
      assignPaneTeam({ paneId: "ambiguous", name: "Team" }, () => {
        throw new Error("IO should not run");
      }),
    ).toThrow("exact pane");
  });
});
