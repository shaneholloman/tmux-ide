/** Closed qualification-driver authority. This never selects a production owner. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  realpathSync,
} from "node:fs";

const exact = (value, keys) => {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const hash = (value, length) =>
  assert(typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value));
const absolute = (value) =>
  assert(
    typeof value === "string" &&
      value.startsWith("/") &&
      value.length <= 4096 &&
      !/[\x00-\x1f\x7f]/u.test(value) &&
      resolve(value) === value,
  );

export const SPARK_DRIVER_ACTIONS = Object.freeze([
  "prepare",
  "secondary-start",
  "secondary-seed",
  "secondary-probe",
  "secondary-retire",
  "stamp-blocked",
  "stamp-done",
  "replace-owner",
  "cleanup",
]);

export function validateSparkDriverDescriptor(value) {
  exact(value, ["version", "nonce", "root", "execution", "source", "tools", "instance"]);
  assert.equal(value.version, 1);
  hash(value.nonce, 32);
  assert.equal(value.root, `/tmp/tia-ssh-${value.nonce}`);
  exact(value.execution, ["bootId", "pidNamespace", "uid"]);
  assert(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.execution.bootId));
  assert(/^pid:\[\d+\]$/u.test(value.execution.pidNamespace));
  assert(Number.isSafeInteger(value.execution.uid) && value.execution.uid > 0);
  exact(value.source, ["path", "commit", "tree"]);
  assert.equal(value.source.path, `${value.root}/source`);
  hash(value.source.commit, 40);
  hash(value.source.tree, 40);
  exact(value.tools, ["node", "bun", "native"]);
  for (const tool of Object.values(value.tools)) {
    exact(tool, ["path", "sha256"]);
    absolute(tool.path);
    hash(tool.sha256, 64);
  }
  assert.equal(
    value.tools.native.path,
    `${value.source.path}/packages/daemon/dist/native/tmux/linux-arm64/tmux`,
  );
  exact(value.instance, ["worktree", "name", "store"]);
  assert.equal(value.instance.worktree, value.source.path);
  assert.equal(value.instance.store, `${value.root}/store`);
  assert.equal(value.instance.name, `spark-${value.nonce}`);
  return value;
}

/** Read only the exact private descriptor; every driver action repeats this check. */
export function readSparkDriverDescriptor(path, execution) {
  absolute(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value;
  try {
    const before = fstatSync(fd);
    assert(
      before.isFile() &&
        before.nlink === 1 &&
        before.uid === execution.uid &&
        (before.mode & 0o777) === 0o600,
    );
    assert(before.size > 0 && before.size <= 16384);
    const bytes = Buffer.alloc(before.size + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd);
    assert.equal(size, before.size);
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"])
      assert.equal(before[key], after[key]);
    value = validateSparkDriverDescriptor(JSON.parse(bytes.subarray(0, size).toString("utf8")));
  } finally {
    closeSync(fd);
  }
  assert.deepEqual(value.execution, execution, "Spark execution identity changed");
  assert.equal(path, `${value.root}/driver.json`);
  assert.equal(realpathSync(value.root), value.root);
  const root = lstatSync(value.root);
  assert(root.isDirectory() && root.uid === execution.uid && (root.mode & 0o777) === 0o700);
  assert.equal(realpathSync(value.source.path), value.source.path);
  assert(lstatSync(value.source.path).isDirectory(), "Qualification source is not a directory");
  return value;
}

export function sparkDriverAction(argv) {
  assert.equal(argv.length, 2, "Driver requires one descriptor and one action");
  absolute(argv[0]);
  assert(SPARK_DRIVER_ACTIONS.includes(argv[1]), "Unknown qualification action");
  return { descriptorPath: argv[0], action: argv[1] };
}
