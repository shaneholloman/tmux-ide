import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSparkCanonicalConfig } from "../qualify-spark-canonical.ts";
import { validateSparkRecoveryReplacement } from "./spark-recovery.ts";
function config() {
  const nonce = "a".repeat(32),
    root = `/tmp/tia-ssh-${nonce}`,
    source = `${root}/source`;
  const instance = { worktree: source, name: `spark-${nonce}`, store: `${root}/store` };
  const local = { worktree: "/private/source", name: "recovery-local", store: "/private/store" };
  const lease = (tuple: typeof instance, daemonId: string) => ({
    version: 1,
    instanceId: "private-instance",
    ...tuple,
    daemonId,
    pid: 100,
    port: 1234,
    startedAt: "2026-09-29T10:00:00.000Z",
    protocolVersion: 1,
    productVersion: "test",
    generation: "build-one",
    manifestHash: "f".repeat(64),
  });
  return validateSparkCanonicalConfig({
    version: 1,
    ssh: { alias: "spark-private", config: "/private/ssh.config" },
    local: { version: 1, instance: local, expected: lease(local, "local-daemon") },
    remote: {
      lease: { version: 1, instance, expected: lease(instance, "old-daemon") },
      driver: {
        version: 1,
        nonce,
        root,
        execution: {
          bootId: "10000000-0000-4000-8000-000000000001",
          pidNamespace: "pid:[123]",
          uid: 1000,
        },
        source: { path: source, commit: "b".repeat(40), tree: "c".repeat(40) },
        tools: {
          node: { path: "/opt/node", sha256: "d".repeat(64) },
          bun: { path: "/opt/bun", sha256: "e".repeat(64) },
          native: {
            path: `${source}/packages/daemon/dist/native/tmux/linux-arm64/tmux`,
            sha256: "f".repeat(64),
          },
        },
        instance,
      },
    },
  });
}
test("replacement receipt admits only a new owner of the exact same managed tuple", () => {
  const c = config();
  const receipt = {
    replaced: true,
    tmuxPreserved: true,
    staleLeaseRejected: true,
    lease: {
      ...c.remote.lease.expected,
      daemonId: "new-daemon",
      pid: 101,
      port: 2345,
      startedAt: "2026-09-29T10:01:00.000Z",
    },
  };
  assert.deepEqual(validateSparkRecoveryReplacement(c, receipt), receipt.lease);
  for (const altered of [
    { ...receipt, tmuxPreserved: false },
    { ...receipt, staleLeaseRejected: false },
    { ...receipt, extra: true },
    ...["worktree", "name", "store", "instanceId"].map((key) => ({
      ...receipt,
      lease: { ...receipt.lease, [key]: "other" },
    })),
    ...["daemonId", "pid", "startedAt"].map((key) => ({
      ...receipt,
      lease: {
        ...receipt.lease,
        [key]: c.remote.lease.expected[key as keyof typeof c.remote.lease.expected],
      },
    })),
  ])
    assert.throws(() => validateSparkRecoveryReplacement(c, altered));
});
