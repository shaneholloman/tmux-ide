import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateSparkDriverDescriptor as validate,
  sparkDriverAction,
  SPARK_DRIVER_ACTIONS,
} from "./spark-driver-descriptor.mjs";

function descriptor() {
  const nonce = "a".repeat(32),
    root = `/tmp/tia-ssh-${nonce}`,
    source = `${root}/source`;
  return {
    version: 1,
    nonce,
    root,
    execution: {
      bootId: "9bc8d103-87df-4657-833c-6c64a23b7db7",
      pidNamespace: "pid:[4026531836]",
      uid: 1000,
    },
    source: { path: source, commit: "b".repeat(40), tree: "c".repeat(40) },
    tools: {
      node: { path: "/home/thijs/tools/node", sha256: "d".repeat(64) },
      bun: { path: "/home/thijs/tools/bun", sha256: "e".repeat(64) },
      native: {
        path: `${source}/packages/daemon/dist/native/tmux/linux-arm64/tmux`,
        sha256: "f".repeat(64),
      },
    },
    instance: { worktree: source, name: `spark-${nonce}`, store: `${root}/store` },
  };
}

test("driver binds source, native binary and managed tuple to one nonce root", () => {
  const value = descriptor();
  assert.equal(validate(value), value);
  for (const mutate of [
    (d) => (d.root = "/home/thijs"),
    (d) => (d.instance.store = "/home/thijs/.tmux-ide"),
    (d) => (d.instance.worktree = "/other/source"),
    (d) => (d.instance.name = "production"),
    (d) => (d.tools.native.path = "/usr/bin/tmux"),
    (d) => (d.tools.node.path = "/bin/../bin/node"),
    (d) => (d.tools.bun.sha256 = "unverified"),
    (d) => (d.execution.uid = 0),
    (d) => (d.execution.bootId = "not-a-boot-id"),
    (d) => (d.execution.pidNamespace = "host"),
    (d) => (d.source.commit = "HEAD"),
    (d) => (d.source.tree = "main"),
    (d) => (d.nonce = "../other"),
    (d) => (d.extra = true),
    (d) => (d.instance.command = "kill-server"),
  ]) {
    const bad = descriptor();
    mutate(bad);
    assert.throws(() => validate(bad));
  }
});

test("driver accepts only closed actions, never user tmux arguments", () => {
  const path = `${descriptor().root}/driver.json`;
  for (const action of SPARK_DRIVER_ACTIONS)
    assert.equal(sparkDriverAction([path, action]).action, action);
  for (const argv of [
    [path],
    [path, "exec"],
    [path, "cleanup", "--force"],
    ["relative", "prepare"],
    [path, "send-keys -t user dangerous"],
  ])
    assert.throws(() => sparkDriverAction(argv));
});
