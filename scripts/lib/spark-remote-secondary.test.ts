import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSparkRemoteSecondary,
  type SparkRemoteSecondaryAction,
} from "./spark-remote-secondary.ts";
const root = `/tmp/tia-ssh-${"a".repeat(32)}`;
const serverId = `tmux-server.${"b".repeat(32)}`;
function live() {
  return {
    socket: `${root}/secondary.sock`,
    proof: {
      socket: { path: `${root}/secondary.sock`, dev: 1, ino: 2, mtimeNs: "3", birthtimeNs: "4" },
      pid: "12",
      startTime: "34",
      witness: JSON.stringify({
        bootId: "10000000-0000-4000-8000-000000000001",
        pidNamespace: "pid:[123]",
        uid: 1000,
        pid: 12,
        identity: `linux:56:${root}/source/packages/daemon/dist/native/tmux/linux-arm64/tmux`,
      }),
    },
  };
}
function fixture() {
  const calls: [SparkRemoteSecondaryAction, string | undefined][] = [];
  const results: Record<SparkRemoteSecondaryAction, unknown> = {
    "secondary-start": live(),
    "secondary-seed": live(),
    "secondary-bind-registration": { bound: true },
    "secondary-retire": { retired: true },
  };
  const secondary = createSparkRemoteSecondary({
    root,
    runAction: async (action, id) => {
      calls.push([action, id]);
      const result = results[action];
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { secondary, calls, results };
}
test("fixed adapter routes lifecycle and delegates file removal to outer cleanup", async () => {
  const f = fixture();
  assert.equal(f.secondary.retainedRoot, root);
  await assert.rejects(f.secondary.seed());
  assert.throws(() => f.secondary.removeFiles());
  await assert.rejects(f.secondary.start("other"));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.secondary.start("pane.shared"), { socket: `${root}/secondary.sock` });
  await assert.rejects(f.secondary.seed());
  await f.secondary.registered!(serverId);
  await f.secondary.seed();
  await f.secondary.retire();
  f.secondary.removeFiles();
  await f.secondary.retire();
  assert.deepEqual(f.calls, [
    ["secondary-start", undefined],
    ["secondary-bind-registration", serverId],
    ["secondary-seed", undefined],
    ["secondary-retire", undefined],
  ]);
  await assert.rejects(f.secondary.start("pane.shared"));
  await assert.rejects(f.secondary.seed());
});
test("malformed start proof is never admitted or retried", async () => {
  const invalid = [
    { ...live(), extra: true },
    { ...live(), socket: "/tmp/other" },
    { ...live(), proof: { ...live().proof, pid: "13" } },
    { ...live(), proof: { ...live().proof, witness: "not-json" } },
    {
      ...live(),
      proof: { ...live().proof, socket: { ...live().proof.socket, path: "/tmp/other" } },
    },
  ];
  for (const result of invalid) {
    const f = fixture();
    f.results["secondary-start"] = result;
    await assert.rejects(f.secondary.start("pane.shared"));
    await assert.rejects(f.secondary.start("pane.shared"));
    await assert.rejects(f.secondary.registered!(serverId));
    assert.equal(f.calls.length, 1);
    assert.throws(() => f.secondary.removeFiles());
  }
});
test("failed or unexpected retirement retains removal prohibition", async () => {
  for (const result of [
    new Error("transport failed"),
    { retired: false },
    { retired: true, extra: true },
  ]) {
    const f = fixture();
    await f.secondary.start("pane.shared");
    f.results["secondary-retire"] = result;
    await assert.rejects(f.secondary.retire());
    assert.throws(() => f.secondary.removeFiles());
    f.results["secondary-retire"] = { retired: true };
    await f.secondary.retire();
    f.secondary.removeFiles();
  }
});
test("binding failure and changed seed proof cannot report success", async () => {
  const f = fixture();
  await f.secondary.start("pane.shared");
  await assert.rejects(f.secondary.registered!("tmux-server.invalid"));
  f.results["secondary-bind-registration"] = { bound: false };
  await assert.rejects(f.secondary.registered!(serverId));
  await assert.rejects(f.secondary.seed());
  await assert.rejects(f.secondary.registered!(serverId));
  const g = fixture();
  await g.secondary.start("pane.shared");
  await g.secondary.registered!(serverId);
  g.results["secondary-seed"] = { ...live(), proof: { ...live().proof, startTime: "35" } };
  await assert.rejects(g.secondary.seed(), /proof changed/);
});
