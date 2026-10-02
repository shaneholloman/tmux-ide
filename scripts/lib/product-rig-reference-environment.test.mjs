import assert from "node:assert/strict";
import { test } from "node:test";
import { productRigReferenceEnvironment } from "./product-rig-reference-environment.mjs";

const state = {
  runtimeNamespace: {
    tmuxSocketPath: "/private/target.sock",
    hostTmuxSocketPath: "/private/host.sock",
    daemonInfoDir: "/private/daemon",
  },
  tui: { runtimeDir: "/private/tui", hostSession: "_fixture" },
};
test("rehosting retains distinct private host and target authority, never inherited defaults", () => {
  const env = productRigReferenceEnvironment(state, {
    PATH: "/bin",
    TMUX: "foreign",
    TMUX_IDE_TMUX_SOCKET_NAME: "default",
    TMUX_IDE_HOME: "/foreign",
  });
  assert.equal(env.TMUX_IDE_TMUX_SOCKET_PATH, "/private/target.sock");
  assert.equal(env.TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH, "/private/host.sock");
  assert.equal(env.TMUX_IDE_TMUX_SOCKET_NAME, undefined);
  assert.equal(env.TMUX_IDE_HOME, undefined);
  assert.equal(env.PATH, "/bin");
});
test("missing or relative target authority refuses instead of falling back", () => {
  for (const value of [undefined, "relative", ""]) {
    assert.throws(
      () =>
        productRigReferenceEnvironment({
          ...state,
          runtimeNamespace: { ...state.runtimeNamespace, tmuxSocketPath: value },
        }),
      /private ProductTestRig authority/,
    );
  }
});
