import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createClaudeTeamNameReader,
  createClaudeTeamMembershipReader,
  parseClaudeTeamMembers,
  resolveClaudeTeamName,
} from "./claude-team-names.ts";

const config = {
  name: "session-one",
  members: [
    {
      name: "researcher",
      agentId: "researcher@session-one",
      tmuxPaneId: "%1",
      backendType: "tmux",
    },
  ],
};
const members = parseClaudeTeamMembers(config, "session-one");
const processes = [
  { pid: 10, ppid: 1, command: "zsh" },
  {
    pid: 11,
    ppid: 10,
    command:
      "/usr/local/bin/claude --team-name session-one --agent-name researcher --agent-id researcher@session-one",
  },
  { pid: 20, ppid: 1, command: "zsh" },
];

describe("Claude team names", () => {
  it("binds to the live pane subtree, not a server-local pane number alone", () => {
    expect(resolveClaudeTeamName({ runtimePaneId: "%1", pid: 10 }, members, processes)).toBe(
      "researcher",
    );
    expect(resolveClaudeTeamName({ runtimePaneId: "%1", pid: 20 }, members, processes)).toBeNull();
    expect(resolveClaudeTeamName({ runtimePaneId: "%2", pid: 10 }, members, processes)).toBeNull();
    expect(resolveClaudeTeamName({ runtimePaneId: "%1", pid: 999 }, members, processes)).toBeNull();
  });
  it("does not bind stale metadata, ambiguous matches, shell text, or another member", () => {
    for (const command of [
      "zsh",
      "echo claude --team-name session-one --agent-name researcher --agent-id researcher@session-one",
      processes[1]!.command.replace("--agent-name researcher", "--agent-name reviewer"),
      processes[1]!.command + " --team-name other",
    ]) {
      expect(
        resolveClaudeTeamName({ runtimePaneId: "%1", pid: 10 }, members, [
          processes[0]!,
          { pid: 11, ppid: 10, command },
        ]),
      ).toBeNull();
    }
    expect(
      resolveClaudeTeamName({ runtimePaneId: "%1", pid: 10 }, [...members, ...members], processes),
    ).toBeNull();
  });
  it("ignores unknown formats and logical members without their own tmux pane", () => {
    for (const value of [
      null,
      {},
      { ...config, name: "another" },
      { ...config, members: [{ ...config.members[0], tmuxPaneId: "in-process" }] },
      { ...config, members: [{ ...config.members[0], backendType: "iterm2" }] },
      { ...config, members: [{ ...config.members[0], name: "bad\u001bname" }] },
    ]) {
      expect(parseClaudeTeamMembers(value, "session-one")).toEqual([]);
    }
  });
  it("shares concurrent reads and removes names after team deletion or process exit", async () => {
    let now = 0;
    let reads = 0;
    let currentMembers = members;
    let currentProcesses = processes;
    const read = createClaudeTeamNameReader("unused", {
      now: () => now,
      readMembers: async () => {
        reads++;
        return currentMembers;
      },
      readProcesses: async () => currentProcesses,
    });
    const panes = [{ runtimePaneId: "%1", pid: 10 }];
    const results = await Promise.all([read(panes), read(panes)]);
    expect(results.map((r) => r.get("%1"))).toEqual(["researcher", "researcher"]);
    expect(reads).toBe(1);
    currentProcesses = [];
    now = 2000;
    expect((await read(panes)).size).toBe(0);
    currentProcesses = processes;
    now = 4000;
    expect((await read(panes)).get("%1")).toBe("researcher");
    currentMembers = [];
    now = 6000;
    expect((await read(panes)).size).toBe(0);
  });
  it("reads atomic replacement and deletion without retaining stale team names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmux-ide-team-names-"));
    try {
      let now = 0;
      const team = join(dir, "session-one");
      await mkdir(team);
      const file = join(team, "config.json");
      await writeFile(file, JSON.stringify(config));
      const read = createClaudeTeamNameReader(dir, {
        now: () => now,
        readProcesses: async () => processes,
      });
      const panes = [{ runtimePaneId: "%1", pid: 10 }];
      expect((await read(panes)).get("%1")).toBe("researcher");
      await writeFile(file + ".new", JSON.stringify({ ...config, members: [] }));
      await rename(file + ".new", file);
      now += 2000;
      expect((await read(panes)).size).toBe(0);
      await rm(team, { recursive: true });
      now += 2000;
      expect((await read(panes)).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("returns native membership without guessing a lead or changing the member name", async () => {
  const read = createClaudeTeamMembershipReader("unused", {
    readMembers: async () => members,
    readProcesses: async () => processes,
  });
  const result = await read([
    { runtimePaneId: "%1", pid: 10 },
    { runtimePaneId: "%0", pid: 20 },
  ]);
  expect(result.get("%1")).toMatchObject({
    name: "researcher",
    team: { name: "session-one", source: "claude-code" },
  });
  expect(result.get("%0")).toBeUndefined();
});
