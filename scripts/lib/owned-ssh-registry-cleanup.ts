/** Fixture-only cleanup of the exact empty workspace registry created by its secondary owner. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import {
  readDevelopmentIdentity,
  readPrivateDevelopmentFile,
} from "../../packages/daemon/src/lib/development-state.ts";
import { verifyDevelopmentRuntimeOwner } from "../../packages/daemon/src/lib/development-runtime-owner.ts";
import { statusDevelopmentInstance } from "../../packages/daemon/src/lib/development-lifecycle.ts";
import { withDevelopmentLock } from "../../packages/daemon/src/lib/development-lock.ts";
export async function cleanupOwnedSshRegistry(
  instance: DevelopmentInstance,
  createdServerId: string,
) {
  assert(/^tmux-server\.[0-9a-f]{32}$/.test(createdServerId));
  return withDevelopmentLock(instance, "lifecycle", async () => {
    const identity = await readDevelopmentIdentity(instance);
    assert(identity && verifyDevelopmentRuntimeOwner(instance, identity));
    const status = await statusDevelopmentInstance(instance);
    assert.equal(status.state, "stopped");
    assert.equal(status.daemon, null);
    assert.equal(status.tmux, null);
    const parent = join(instance.runtimeDir, "server-owners");
    const directory = join(parent, createdServerId);
    for (const path of [parent, directory]) {
      const stat = lstatSync(path);
      assert(
        stat.isDirectory() &&
          !stat.isSymbolicLink() &&
          stat.uid === process.getuid?.() &&
          (stat.mode & 0o077) === 0,
      );
    }
    assert.deepEqual(readdirSync(parent), [createdServerId]);
    assert.deepEqual(readdirSync(directory), ["workspaces.json"]);
    const path = join(directory, "workspaces.json");
    const file = readPrivateDevelopmentFile(path);
    assert(file);
    assert.deepEqual(JSON.parse(file.bytes.toString("utf8")), { version: 1, workspaces: [] });
    assert(verifyDevelopmentRuntimeOwner(instance, identity));
    const current = lstatSync(path);
    assert(current.isFile() && current.dev === file.dev && current.ino === file.ino);
    const evidence = {
      createdServerId,
      path,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
      bytes: file.bytes.length,
    };
    unlinkSync(path);
    rmdirSync(directory);
    rmdirSync(parent);
    return evidence;
  });
}
