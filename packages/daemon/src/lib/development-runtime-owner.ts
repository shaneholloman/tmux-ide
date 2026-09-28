/** Durable ownership of the short runtime path, whose identity intentionally excludes the store. */
import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateDevelopmentDirectory, type DevelopmentInstance } from "./development-instance.ts";
import {
  DevelopmentOperationError,
  readPrivateDevelopmentRecord,
  readPrivateDevelopmentFile,
  type DevelopmentIdentityRecord,
} from "./development-state.ts";
import { z } from "zod";
import { TmuxServerRegistrationSchemaZ } from "./tmux-server-owners.ts";
const DefaultRegistrations = z
  .object({ version: z.literal(1), servers: z.array(TmuxServerRegistrationSchemaZ).max(1) })
  .strict();
const OWNER = "development-owner.json";
function expected(instance: DevelopmentInstance, identity: DevelopmentIdentityRecord) {
  return {
    version: 1,
    id: instance.id,
    digest: instance.digest,
    worktree: instance.worktree,
    name: instance.name,
    store: instance.store,
    root: instance.root,
    capability: identity.capability,
  };
}
function mismatch() {
  return new DevelopmentOperationError(
    "owner-unverified",
    "Development runtime is owned by another store or has unverified legacy contents",
  );
}
/** Read-only. Missing empty directories carry no active authority; nonempty legacy paths are protected. */
export function verifyDevelopmentRuntimeOwner(
  instance: DevelopmentInstance,
  identity: DevelopmentIdentityRecord,
): boolean {
  validateDevelopmentDirectory(instance.runtimeDir, dirname(instance.runtimeDir));
  const record = readPrivateDevelopmentRecord<Record<string, unknown>>(
    join(instance.runtimeDir, OWNER),
  );
  if (record) {
    const required = expected(instance, identity);
    if (
      Object.keys(record).length !== Object.keys(required).length ||
      Object.entries(required).some(([key, value]) => record[key] !== value)
    )
      throw mismatch();
    return true;
  }
  try {
    if (readdirSync(instance.runtimeDir).length !== 0) throw mismatch();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return false;
}
/** Complete private inode, atomically linked without overwriting another store's claim. */
export function claimDevelopmentRuntimeOwner(
  instance: DevelopmentInstance,
  identity: DevelopmentIdentityRecord,
): void {
  if (verifyDevelopmentRuntimeOwner(instance, identity)) return;
  mkdirSync(instance.runtimeDir, { recursive: true, mode: 0o700 });
  const owner = join(instance.runtimeDir, OWNER);
  // Stage outside the shared runtime directory: another claimant must not mistake
  // our temporary payload for unowned legacy runtime contents.
  const temp = join(
    dirname(instance.runtimeDir),
    `.runtime-owner-${instance.id}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temp, JSON.stringify(expected(instance, identity)), { flag: "wx", mode: 0o600 });
    try {
      linkSync(temp, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(temp, { force: true });
  }
  if (!verifyDevelopmentRuntimeOwner(instance, identity)) throw mismatch();
}
/** Caller has excluded managed apps/processes and holds its lifecycle lock. */
export function releaseDevelopmentRuntimeOwner(
  instance: DevelopmentInstance,
  identity: DevelopmentIdentityRecord,
): void {
  if (!verifyDevelopmentRuntimeOwner(instance, identity)) return;
  const entries = readdirSync(instance.runtimeDir);
  if (entries.some((entry) => entry !== OWNER && entry !== "tmux-servers.json"))
    throw new DevelopmentOperationError(
      "owner-unverified",
      "Unknown runtime entries protect this instance from reset",
    );
  const registrationsPath = join(instance.runtimeDir, "tmux-servers.json");
  // Only metadata for this already-retired private socket is disposable. External
  // registrations and unknown files remain protected, even when processes died.
  const file = readPrivateDevelopmentFile(registrationsPath);
  if (file) {
    const registrations = DefaultRegistrations.safeParse(JSON.parse(file.bytes.toString("utf8")));
    if (
      !registrations.success ||
      registrations.data.servers.some(
        (entry) =>
          entry.selector.kind !== "path" ||
          entry.selector.path !== join(instance.runtimeDir, "tmux.sock"),
      )
    )
      throw mismatch();
    if (!verifyDevelopmentRuntimeOwner(instance, identity)) throw mismatch();
    const current = lstatSync(registrationsPath);
    if (!current.isFile() || current.dev !== file.dev || current.ino !== file.ino) throw mismatch();
    rmSync(registrationsPath);
  }
  rmSync(join(instance.runtimeDir, OWNER));
}
