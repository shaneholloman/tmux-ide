/** Read-only compatibility adapter for Claude Code's runtime team metadata.
 * Names are presentation evidence, never agent identity or permission authority.
 */
import { open, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  readProcessTableAsync,
  subtreeEntries,
  type ProcEntry,
} from "../../tui/detect/process-tree.ts";

export interface ClaudeTeamMember {
  readonly team: string;
  readonly name: string;
  readonly agentId: string;
  readonly paneId: string;
}
export interface TeamPaneProcess {
  readonly runtimePaneId: string;
  readonly pid: number;
}
const token = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_.@-]{1,160}$/u.test(value) &&
  value !== "." &&
  value !== "..";

export function parseClaudeTeamMembers(value: unknown, directory: string): ClaudeTeamMember[] {
  if (!value || typeof value !== "object") return [];
  const config = value as Record<string, unknown>;
  if (
    !token(directory) ||
    config.name !== directory ||
    !Array.isArray(config.members) ||
    config.members.length > 128
  )
    return [];
  return config.members.flatMap((value): ClaudeTeamMember[] => {
    if (!value || typeof value !== "object") return [];
    const m = value as Record<string, unknown>;
    if (
      !token(m.name) ||
      m.name.length > 80 ||
      !token(m.agentId) ||
      m.backendType !== "tmux" ||
      typeof m.tmuxPaneId !== "string" ||
      !/^%\d+$/u.test(m.tmuxPaneId)
    )
      return [];
    return [{ team: directory, name: m.name, agentId: m.agentId, paneId: m.tmuxPaneId }];
  });
}

/** Conservative argv recognition: flattened ps text is not a shell parser.
 * Ambiguous/quoted arguments fall back to the native title rather than guessing.
 */
function matchesProcess(command: string, member: ClaudeTeamMember): boolean {
  const args = command.trim().split(/\s+/u);
  const executable = args.shift() ?? "";
  if (basename(executable) !== "claude" && !/\/claude\/versions\/\d[\w.-]*$/u.test(executable))
    return false;
  for (const [flag, expected] of [
    ["--team-name", member.team],
    ["--agent-id", member.agentId],
    ["--agent-name", member.name],
  ]) {
    const positions = args.flatMap((arg, index) =>
      arg === flag || arg.startsWith(`${flag}=`) ? [index] : [],
    );
    if (positions.length !== 1) return false;
    const i = positions[0]!;
    if ((args[i] === flag ? args[i + 1] : args[i]!.slice(flag!.length + 1)) !== expected)
      return false;
  }
  return true;
}

export function resolveClaudeTeamName(
  pane: TeamPaneProcess,
  members: readonly ClaudeTeamMember[],
  processes: ProcEntry[],
): string | null {
  // A native pane id alone cannot bind a team: different servers reuse %N.
  // Its live shell PID scopes the match to this host and this pane's subtree.
  const subtree = subtreeEntries(processes, pane.pid);
  const matches = members.filter(
    (m) => m.paneId === pane.runtimePaneId && subtree.some((p) => matchesProcess(p.command, m)),
  );
  return matches.length === 1 ? matches[0]!.name : null;
}

async function readMembers(directory: string): Promise<ClaudeTeamMember[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 128) return [];
    const members: ClaudeTeamMember[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !token(entry.name)) continue;
      try {
        const file = await open(join(directory, entry.name, "config.json"), "r");
        try {
          if (!(await file.stat()).isFile()) continue;
          const bytes = Buffer.alloc(256 * 1024 + 1);
          const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
          if (bytesRead > 256 * 1024) continue;
          members.push(
            ...parseClaudeTeamMembers(
              JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
              entry.name,
            ),
          );
        } finally {
          await file.close();
        }
      } catch {
        /* Removal, atomic replacement and unknown schemas clear old facts. */
      }
    }
    return members;
  } catch {
    return [];
  }
}

export type ClaudeTeamNameReader = (
  panes: readonly TeamPaneProcess[],
) => Promise<ReadonlyMap<string, string>>;

export function createClaudeTeamNameReader(
  directory: string,
  deps: {
    readMembers?: () => Promise<ClaudeTeamMember[]>;
    readProcesses?: () => Promise<ProcEntry[]>;
    now?: () => number;
  } = {},
): ClaudeTeamNameReader {
  const now = deps.now ?? Date.now;
  let snapshot: { at: number; members: ClaudeTeamMember[]; processes: ProcEntry[] } | null = null;
  let pending: Promise<void> | null = null;
  return async (panes) => {
    if (!panes.length) return new Map();
    if (!snapshot || now() - snapshot.at >= 2000) {
      pending ??= (async () => {
        try {
          const members = await (deps.readMembers?.() ?? readMembers(directory));
          const processes = members.length
            ? await (deps.readProcesses?.() ?? readProcessTableAsync())
            : [];
          snapshot = { at: now(), members, processes };
        } catch {
          snapshot = { at: now(), members: [], processes: [] };
        }
      })().finally(() => {
        pending = null;
      });
      await pending;
    }
    const current = snapshot!;
    const names = new Map<string, string>();
    for (const pane of panes) {
      const name = resolveClaudeTeamName(pane, current.members, current.processes);
      if (name) names.set(pane.runtimePaneId, name);
    }
    return names;
  };
}
