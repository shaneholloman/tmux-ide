import { isAbsolute } from "node:path";

/** Rehost only on the explicit rig's private host and target servers. */
export function productRigReferenceEnvironment(state, inherited = process.env) {
  const ns = state?.runtimeNamespace;
  const tui = state?.tui;
  for (const value of [
    ns?.tmuxSocketPath,
    ns?.hostTmuxSocketPath,
    ns?.daemonInfoDir,
    tui?.runtimeDir,
  ])
    if (typeof value !== "string" || !isAbsolute(value) || /[\0\r\n]/u.test(value))
      throw new Error("Incomplete private ProductTestRig authority");
  if (typeof tui.hostSession !== "string" || !/^[A-Za-z0-9_-]+$/u.test(tui.hostSession))
    throw new Error("Invalid private ProductTestRig host session");
  const env = { ...inherited };
  for (const key of Object.keys(env))
    if (key === "TMUX" || key.startsWith("TMUX_")) delete env[key];
  return {
    ...env,
    TMUX: "",
    TMUX_IDE_TMUX_SOCKET_PATH: ns.tmuxSocketPath,
    TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: ns.hostTmuxSocketPath,
    TMUX_IDE_TESTDRIVE_RUNTIME_DIR: tui.runtimeDir,
    TMUX_IDE_TESTDRIVE_HOST_SESSION: tui.hostSession,
    TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
    TMUX_IDE_TESTDRIVE_CANONICAL_HOME: ns.daemonInfoDir,
  };
}
