import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSparkCanonicalConfig,
  readSparkCanonicalConfig,
  safeSparkAttributionFailureStage,
  safeSparkCleanupFailures,
} from "../qualify-spark-canonical.ts";
function config() {
  const nonce = "a".repeat(32),
    root = `/tmp/tia-ssh-${nonce}`,
    source = `${root}/source`;
  const remoteTuple = { worktree: source, name: `spark-${nonce}`, store: `${root}/store` };
  const localTuple = {
    worktree: "/private/local/source",
    name: "canonical-observer",
    store: "/private/local/store",
  };
  const lease = (instance: typeof localTuple, daemonId: string) => ({
    version: 1,
    instanceId: "managed-instance",
    ...instance,
    daemonId,
    pid: 123,
    port: 1234,
    startedAt: "2026-09-29T12:00:00.000Z",
    protocolVersion: 1,
    productVersion: "test",
    generation: "test-generation",
    manifestHash: "f".repeat(64),
  });
  return {
    version: 1,
    ssh: { alias: "spark-private", config: "/private/local/ssh-config" },
    local: { version: 1, instance: localTuple, expected: lease(localTuple, "local-daemon") },
    remote: {
      lease: { version: 1, instance: remoteTuple, expected: lease(remoteTuple, "remote-daemon") },
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
          node: { path: "/opt/pinned/node", sha256: "d".repeat(64) },
          bun: { path: "/opt/pinned/bun", sha256: "e".repeat(64) },
          native: {
            path: `${source}/packages/daemon/dist/native/tmux/linux-arm64/tmux`,
            sha256: "f".repeat(64),
          },
        },
        instance: remoteTuple,
      },
    },
  };
}
test("configuration admits only explicitly bound prepared managed tuples", () => {
  assert.deepEqual(validateSparkCanonicalConfig(config()), config());
  for (const mutation of [
    (c: ReturnType<typeof config>) => {
      c.local.instance.name = "";
    },
    (c: ReturnType<typeof config>) => {
      c.local.expected.store = "/other/store";
    },
    (c: ReturnType<typeof config>) => {
      c.remote.lease.expected.port = 0;
    },
    (c: ReturnType<typeof config>) => {
      c.remote.lease.expected.daemonId = "local-daemon";
    },
    (c: ReturnType<typeof config>) => {
      c.remote.driver.tools.native.path = "/usr/bin/tmux";
    },
    (c: ReturnType<typeof config>) => {
      c.remote.driver.instance = { ...c.remote.driver.instance, name: "production" };
    },
    (c: ReturnType<typeof config>) => {
      c.ssh.alias = "host; arbitrary";
    },
    (c: ReturnType<typeof config>) => {
      c.ssh.config = "/tmp/../config";
    },
  ]) {
    const c = config();
    mutation(c);
    assert.throws(() => validateSparkCanonicalConfig(c));
  }
  assert.throws(() => validateSparkCanonicalConfig({ ...config(), execute: "anything" }));
});
test("runner config reads are private, bounded, and reject symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "spark-canonical-config-"));
  const path = join(root, "config.json");
  try {
    writeFileSync(path, JSON.stringify(config()), { mode: 0o600 });
    assert.deepEqual(readSparkCanonicalConfig(path), config());
    chmodSync(path, 0o644);
    assert.throws(() => readSparkCanonicalConfig(path));
    chmodSync(path, 0o600);
    const link = join(root, "link.json");
    symlinkSync(path, link);
    assert.throws(() => readSparkCanonicalConfig(link));
    writeFileSync(path, "x".repeat(65537));
    assert.throws(() => readSparkCanonicalConfig(path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure diagnostics admit only the fixed attribution stage vocabulary", () => {
  assert.equal(safeSparkAttributionFailureStage("secondary-register"), "secondary-register");
  assert.equal(safeSparkAttributionFailureStage("default-clock-barrier"), "default-clock-barrier");
  for (const value of [
    "Bearer private-token",
    "unknown-stage",
    { message: "private" },
    null,
    undefined,
  ])
    assert.equal(safeSparkAttributionFailureStage(value), null);
});

test("cleanup diagnostics preserve component labels and discard private messages", () => {
  assert.deepEqual(
    safeSparkCleanupFailures([
      "private-tmux: PRIVATE command",
      "transport: PRIVATE endpoint",
      "private-tmux: duplicate",
      "unknown: PRIVATE",
      null,
      "PRIVATE",
    ]),
    ["private-tmux", "transport"],
  );
  assert.deepEqual(safeSparkCleanupFailures("PRIVATE"), []);
});
