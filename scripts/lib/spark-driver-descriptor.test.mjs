import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  linkSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import {
  validateSparkDriverDescriptor as validate,
  sparkDriverAction,
  SPARK_DRIVER_ACTIONS,
  readSparkDriverDescriptor,
} from "./spark-driver-descriptor.mjs";

function descriptor(nonce = "a".repeat(32)) {
  const root = `/tmp/tia-ssh-${nonce}`,
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
    assert.equal(
      sparkDriverAction([
        path,
        action,
        ...(action === "secondary-bind-registration" ? ["tmux-server." + "a".repeat(32)] : []),
      ]).action,
      action,
    );
  for (const argv of [
    [path],
    [path, "exec"],
    [path, "cleanup", "--force"],
    ["relative", "prepare"],
    [path, "send-keys -t user dangerous"],
  ])
    assert.throws(() => sparkDriverAction(argv));
});

test(
  "Linux private reader rejects changed ownership boundaries and authority files",
  { skip: process.platform !== "linux" || process.getuid() === 0 },
  () => {
    const value = descriptor(randomBytes(16).toString("hex"));
    value.execution.uid = process.getuid();
    const root = value.root,
      file = `${root}/driver.json`;
    mkdirSync(root, { mode: 0o700 });
    try {
      mkdirSync(value.source.path, { mode: 0o700 });
      const reset = () => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      reset();
      assert.deepEqual(readSparkDriverDescriptor(file, value.execution), value);
      assert.throws(() =>
        readSparkDriverDescriptor(file, { ...value.execution, uid: value.execution.uid + 1 }),
      );
      chmodSync(file, 0o644);
      assert.throws(() => readSparkDriverDescriptor(file, value.execution));
      chmodSync(file, 0o600);
      linkSync(file, `${root}/hardlink`);
      assert.throws(() => readSparkDriverDescriptor(file, value.execution));
      unlinkSync(`${root}/hardlink`);
      writeFileSync(file, "x".repeat(16385));
      assert.throws(() => readSparkDriverDescriptor(file, value.execution));
      reset();
      unlinkSync(file);
      symlinkSync(`${root}/other`, file);
      assert.throws(() => readSparkDriverDescriptor(file, value.execution));
      unlinkSync(file);
      reset();
      chmodSync(root, 0o755);
      assert.throws(() => readSparkDriverDescriptor(file, value.execution));
      chmodSync(root, 0o700);
      rmSync(value.source.path, { recursive: true });
      writeFileSync(value.source.path, "not a directory");
      assert.throws(() => readSparkDriverDescriptor(file, value.execution));
      unlinkSync(value.source.path);
      symlinkSync(root, value.source.path);
      assert.throws(() => readSparkDriverDescriptor(file, value.execution));
    } finally {
      rmSync(root, { recursive: true });
    }
  },
);
