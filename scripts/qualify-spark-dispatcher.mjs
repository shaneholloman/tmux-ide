#!/usr/bin/env node
/** Local managed-instance proof only. Never contacts SSH or Spark. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RemoteDaemonHandshakeSchema } from "../packages/daemon/src/lib/ssh-daemon-transport.ts";
import { resolveDevelopmentInstance } from "../packages/daemon/src/lib/development-instance.ts";
import { developmentSshAuthority } from "../packages/daemon/src/lib/development-ssh.ts";
import { createPackedCancellation } from "./lib/packed-cancellation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2]);
mkdirSync(output, { mode: 0o700 });
const tuple = {
  worktree: root,
  name: `dispatcher-${randomUUID().slice(0, 12)}`,
  store: join(output, "store"),
};
const instance = resolveDevelopmentInstance(tuple);
const cancellation = createPackedCancellation();
const failures = [];
const facts = { schemaVersion: 1, localOnly: true, completed: false, cases: [], cleanup: false };
let startupAttempted = false;
let rebuildAttempted = false;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("TMUX") &&
      !key.startsWith("GIT_") &&
      !["NODE_OPTIONS", "NODE_PATH"].includes(key),
  ),
);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const provenance = () => ({
  commit: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  dirty: git("status", "--porcelain", "--untracked-files=all"),
  node: process.execPath,
  nodeHash: sha(process.execPath),
  lockHash: sha(join(root, "pnpm-lock.yaml")),
});
const before = provenance();
facts.provenance = before;
async function manager(action) {
  const result = await cancellation.command(
    process.execPath,
    [
      join(root, "scripts/development-instance.mjs"),
      action,
      ...(action === "reset" ? ["--yes"] : []),
      "--worktree",
      root,
      "--name",
      tuple.name,
      "--store",
      tuple.store,
      "--json",
    ],
    { cwd: root, env, timeout: action === "rebuild" ? 240000 : 60000, maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) {
    writeFileSync(
      join(output, `${action}-failure.log`),
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      { mode: 0o600 },
    );
    throw new Error(`Private managed ${action} failed; private diagnostic retained`);
  }
  return JSON.parse(result.stdout);
}
async function dispatch(descriptor, success, label) {
  const path = join(output, `${label}.json`);
  writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600, flag: "wx" });
  const result = await cancellation.command(
    process.execPath,
    [join(root, "scripts/spark-qualification-handshake.mjs"), path],
    { cwd: root, env, timeout: 15000, maxBuffer: 65536 },
  );
  assert.equal(result.status === 0, success, label);
  if (!success) {
    assert.equal(result.stdout, "", "rejection must not disclose handshake credentials");
    assert.match(result.stderr, /descriptor shape refused|no matching verified ready owner/u);
  }
  facts.cases.push({ label, accepted: result.status === 0 });
  return success ? RemoteDaemonHandshakeSchema.parse(JSON.parse(result.stdout)) : null;
}
try {
  assert.equal(before.dirty, "", "Commit qualification source before running");
  rebuildAttempted = true;
  await manager("rebuild");
  startupAttempted = true;
  await manager("up");
  const { lease } = await developmentSshAuthority(instance);
  facts.lease = lease; // No owner token in this structural witness.
  const descriptor = { version: 1, instance: tuple, expected: lease };
  const accepted = await dispatch(descriptor, true, "exact");
  assert.equal(accepted.daemon.instanceId, lease.daemonId);
  assert.equal(accepted.daemon.port, lease.port);
  await dispatch(
    { ...descriptor, expected: Object.fromEntries(Object.entries(lease).reverse()) },
    true,
    "reordered",
  );
  await dispatch({ ...descriptor, expected: { ...lease, daemonId: randomUUID() } }, false, "stale");
  await dispatch({ ...descriptor, instance: null }, false, "null-tuple");
  await dispatch(
    { ...descriptor, expected: { ...lease, unexpected: true } },
    false,
    "unknown-lease-key",
  );
  await dispatch({ ...descriptor, expected: null }, false, "null-lease");
  assert.deepEqual(
    (await developmentSshAuthority(instance)).lease,
    lease,
    "rejections must not replace or start an owner",
  );
} catch (error) {
  failures.push(error);
} finally {
  cancellation.beginCleanup();
  if (startupAttempted) {
    try {
      await manager("down");
      facts.ownerStopped = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (rebuildAttempted) {
    try {
      await manager("reset");
      facts.cleanup = true;
    } catch (error) {
      failures.push(error);
    }
  } else facts.cleanup = true;
  try {
    facts.finalProvenance = provenance();
    assert.deepEqual(facts.finalProvenance, before);
  } catch (error) {
    failures.push(error);
  }
  facts.cancellation = cancellation.facts();
  if (facts.cancellation.uncertainCommand)
    failures.push(new Error("Command retirement unconfirmed"));
  cancellation.dispose();
  facts.completed = failures.length === 0;
  facts.failures = failures.map((error) =>
    error instanceof Error ? error.message : "Unknown failure",
  );
  writeFileSync(join(output, "proof.json"), JSON.stringify(facts, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
}
if (failures.length)
  throw new AggregateError(failures, "Local private dispatcher qualification failed");
