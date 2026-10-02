import { isAbsolute, join, resolve } from "node:path";

// Reuse the testdrive's isolation inputs. Partial overrides must never mix a
// disposable daemon with the user's default tmux server or shared UI state.
export function referenceTarget(root, env = process.env) {
  const keys = [
    "TMUX_IDE_TESTDRIVE_CANONICAL_HOME",
    "TMUX_IDE_TESTDRIVE_RUNTIME_DIR",
    "TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH",
    "TMUX_IDE_TMUX_SOCKET_PATH",
  ];
  const values = keys.map((key) => env[key]?.trim());
  const isolated = values.some(Boolean);
  if (isolated && !values.every((value) => value && isAbsolute(value)))
    throw new Error(`Isolated reference requires absolute paths for ${keys.join(", ")}`);
  if (isolated && values[2] !== values[3])
    throw new Error("Reference host and target must use the same private tmux socket");
  const runtimeDir = isolated ? values[1] : resolve(root, ".tasks/tui-testdrive");
  return {
    isolated,
    runtimeDir,
    daemonInfoPath: join(isolated ? values[0] : join(env.HOME ?? "", ".tmux-ide"), "daemon.json"),
    hostSession: env.TMUX_IDE_TESTDRIVE_HOST_SESSION?.trim() || "_tmux-ide-testdrive",
    socketArgs: isolated ? ["-S", values[2]] : [],
  };
}
