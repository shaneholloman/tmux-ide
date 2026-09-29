#!/usr/bin/env node
/** Private qualification entry point; never resolves the installed/default daemon. */
import assert from "node:assert/strict";
import {
  readFileSync,
  readlinkSync,
  realpathSync,
  openSync,
  closeSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
  constants,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readSparkDriverDescriptor, sparkDriverAction } from "./lib/spark-driver-descriptor.mjs";

try {
  assert.equal(process.platform, "linux");
  // Child-created fixture registries must stay private regardless of the SSH login umask.
  process.umask(0o077);
  const input = sparkDriverAction(process.argv.slice(2));
  const execution = {
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pidNamespace: readlinkSync("/proc/self/ns/pid"),
    uid: process.getuid(),
  };
  const descriptor = readSparkDriverDescriptor(input.descriptorPath, execution);
  assert.equal(
    realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..")),
    descriptor.source.path,
  );
  assert.equal(realpathSync(process.execPath), descriptor.tools.node.path);
  // Parent SSH launch also uses env -i. Clear inherited values before loading helpers.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: descriptor.root,
    PATH: `${dirname(descriptor.tools.node.path)}:${dirname(descriptor.tools.bun.path)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: "/tmp",
    TERM: "xterm-256color",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const { register } = await import("tsx/esm/api");
  register();
  const { verifySparkDriverRuntime } = await import("./lib/spark-driver-runtime.ts");
  await verifySparkDriverRuntime(descriptor);
  const lock = join(descriptor.root, "driver.lock");
  const fd = openSync(
    lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(fd);
  const lockIdentity = lstatSync(lock);
  try {
    const { sparkSecondaryAction } = await import("./lib/spark-secondary.ts");
    let result;
    if (input.action === "secondary-bind-registration") {
      const { bindSparkSecondaryRegistration } =
        await import("./lib/spark-registration-receipt.ts");
      result = await bindSparkSecondaryRegistration(descriptor, input.serverId);
    } else if (input.action.startsWith("secondary-")) {
      result = await sparkSecondaryAction(descriptor, input.action);
    } else if (input.action === "cleanup") {
      const { cleanupSparkManagedInstance } = await import("./lib/spark-managed-cleanup.ts");
      result = await cleanupSparkManagedInstance(descriptor);
    } else {
      const { sparkManagedAction } = await import("./lib/spark-managed-driver.ts");
      result = await sparkManagedAction(descriptor, input.action);
    }
    await verifySparkDriverRuntime(descriptor);
    const receipt = `receipt-${input.action}-${randomUUID()}.json`;
    writeFileSync(
      join(descriptor.root, receipt),
      JSON.stringify({ version: 1, action: input.action, result }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    // Lease-bearing receipts stay on disk; only their generated basename is public.
    process.stdout.write(JSON.stringify({ ok: true, receipt }) + "\n");
  } finally {
    const current = lstatSync(lock);
    assert(
      current.isFile() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino,
    );
    unlinkSync(lock);
  }
} catch {
  // Child errors can contain private command output. Do not serialize them.
  process.stderr.write(
    "Private Spark qualification action refused; retain the owned task directory for inspection.\n",
  );
  process.exitCode = 1;
}
