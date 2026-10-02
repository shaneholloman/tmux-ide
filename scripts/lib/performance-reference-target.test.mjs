import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceTarget } from "./performance-reference-target.mjs";

const isolated = {
  HOME: "/user-home",
  TMUX_IDE_TESTDRIVE_CANONICAL_HOME: "/fixture/daemon",
  TMUX_IDE_TESTDRIVE_RUNTIME_DIR: "/fixture/tui",
  TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: "/fixture/t.sock",
  TMUX_IDE_TMUX_SOCKET_PATH: "/fixture/t.sock",
  TMUX_IDE_TESTDRIVE_HOST_SESSION: "private-ui",
};

test("private reference consistently routes daemon, state, host and target", () => {
  const target = referenceTarget("/repo", isolated);
  assert.equal(target.daemonInfoPath, "/fixture/daemon/daemon.json");
  assert.equal(target.runtimeDir, "/fixture/tui");
  assert.equal(target.hostSession, "private-ui");
  assert.deepEqual(target.socketArgs, ["-S", "/fixture/t.sock"]);
  assert.equal(target.isolated, true);
});

test("partial or relative isolation refuses before accessing shared state", () => {
  for (const key of Object.keys(isolated).filter(
    (key) => key.endsWith("PATH") || key.endsWith("DIR") || key.endsWith("CANONICAL_HOME"),
  )) {
    assert.throws(
      () => referenceTarget("/repo", { ...isolated, [key]: undefined }),
      /requires absolute/,
    );
    assert.throws(
      () => referenceTarget("/repo", { ...isolated, [key]: "relative" }),
      /requires absolute/,
    );
  }
  assert.throws(
    () => referenceTarget("/repo", { ...isolated, TMUX_IDE_TMUX_SOCKET_PATH: "/other.sock" }),
    /same private/,
  );
});

test("existing explicit canonical reference behavior remains available", () => {
  const target = referenceTarget("/repo", { HOME: "/user-home" });
  assert.equal(target.daemonInfoPath, "/user-home/.tmux-ide/daemon.json");
  assert.equal(target.runtimeDir, "/repo/.tasks/tui-testdrive");
  assert.deepEqual(target.socketArgs, []);
  assert.equal(target.isolated, false);
});
