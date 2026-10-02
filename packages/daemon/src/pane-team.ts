import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { runtimeTmuxArgs } from "./lib/runtime-namespace.ts";
import { manualPaneTeamStamp, PANE_TEAM_OPTION } from "./terminal/attachments/manual-pane-team.ts";

/** Explicit membership only. Never launches, stops, or messages an agent. */
export function assignPaneTeam(
  options: {
    paneId: string;
    name: string | null;
    socketPath?: string;
    socketName?: string;
  },
  run: (args: string[]) => string = (args) =>
    execFileSync("tmux", args, { encoding: "utf8", timeout: 5000 }),
) {
  if (!/^%\d+$/u.test(options.paneId)) throw new Error("Use an exact pane ID such as %3");
  if (options.socketPath && options.socketName) throw new Error("Choose one tmux socket selector");
  if (options.socketPath && !isAbsolute(options.socketPath))
    throw new Error("Socket path must be absolute");
  if (options.socketName && !/^[a-zA-Z0-9_.-]+$/u.test(options.socketName))
    throw new Error("Invalid socket name");
  const args = (command: string[]) =>
    options.socketPath
      ? ["-S", options.socketPath, ...command]
      : options.socketName
        ? ["-L", options.socketName, ...command]
        : runtimeTmuxArgs(command);
  const pid = Number(
    run(args(["display-message", "-p", "-t", options.paneId, "#{pane_pid}"])).trim(),
  );
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Pane is no longer available");
  const stamp = options.name === null ? null : manualPaneTeamStamp(options.name, pid);
  run(
    args(
      stamp === null
        ? ["set-option", "-p", "-u", "-t", options.paneId, PANE_TEAM_OPTION]
        : ["set-option", "-p", "-t", options.paneId, PANE_TEAM_OPTION, stamp],
    ),
  );
  return { paneId: options.paneId, team: options.name, source: stamp === null ? null : "manual" };
}
