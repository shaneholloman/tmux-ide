import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import { developmentSshAuthority } from "../../packages/daemon/src/lib/development-ssh.ts";
import { readPrivateDevelopmentFile } from "../../packages/daemon/src/lib/development-state.ts";
import { TmuxServerRegistrationSchemaZ } from "../../packages/daemon/src/lib/tmux-server-owners.ts";
import { sparkSecondaryAction, type SparkSecondaryDescriptor } from "./spark-secondary.ts";
import type { SparkManagedDescriptor } from "./spark-managed-driver.ts";

/** Bind the API-issued ID to the exact secondary before that registration is removed. */
export async function bindSparkSecondaryRegistration(
  d: SparkManagedDescriptor & SparkSecondaryDescriptor,
  serverId: string,
) {
  assert(/^tmux-server\.[a-f0-9]{32}$/u.test(serverId));
  const instance = resolveDevelopmentInstance(d.instance);
  await developmentSshAuthority(instance);
  const observed = await sparkSecondaryAction(d, "secondary-probe");
  assert("socket" in observed);
  const file = readPrivateDevelopmentFile(join(instance.runtimeDir, "tmux-servers.json"));
  assert(file);
  const registrations = z
    .object({ version: z.literal(1), servers: z.array(TmuxServerRegistrationSchemaZ).max(16) })
    .strict()
    .parse(JSON.parse(file.bytes.toString("utf8")));
  const matches = registrations.servers.filter(
    (server) =>
      server.serverId === serverId &&
      server.selector.kind === "path" &&
      server.selector.path === observed.socket,
  );
  assert.equal(matches.length, 1, "Secondary registration does not match the private socket");
  writeFileSync(
    join(d.root, "secondary-registration.json"),
    JSON.stringify({ version: 1, nonce: d.nonce, socket: observed.socket, serverId }) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  return { bound: true };
}
