#!/usr/bin/env -S pnpm exec tsx
/** Prepared-owner physical qualification: discovery, attribution and global clock only. */
import assert from "node:assert/strict";
import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveDevelopmentInstance } from "../packages/daemon/src/lib/development-instance.ts";
import { developmentSshHandshake } from "../packages/daemon/src/lib/development-ssh.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
  RemoteDaemonHandshakeSchema,
} from "../packages/daemon/src/lib/ssh-daemon-transport.ts";
import { qualifyCanonicalSshAttribution } from "./lib/owned-ssh-attribution.ts";
import { createSparkRemoteSecondary } from "./lib/spark-remote-secondary.ts";
import { createSparkRemoteAction, type SparkRemoteExec } from "./lib/spark-remote-action.ts";
import { sparkQualificationSshArgs } from "./lib/spark-qualification-ssh.mjs";
import { validateSparkDriverDescriptor } from "./lib/spark-driver-descriptor.mjs";
import { validateSparkQualificationDescriptor } from "./lib/spark-qualification-descriptor.mjs";
import { unusedLoopbackPort } from "./lib/owned-ssh-fixture.mjs";

const absolute = z
  .string()
  .max(4096)
  .regex(/^\/[A-Za-z0-9_./-]+$/u)
  .refine((value) => resolve(value) === value);
const tuple = z
  .object({
    worktree: absolute,
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/u),
    store: absolute,
  })
  .strict();
const lease = z
  .object({
    version: z.literal(1),
    instanceId: z.string().min(1),
    worktree: absolute,
    name: tuple.shape.name,
    store: absolute,
    daemonId: z.string().min(1),
    pid: z.number().int().positive().safe(),
    port: z.number().int().min(1).max(65535),
    startedAt: z.string().datetime({ offset: true }),
    protocolVersion: z.number().int().positive(),
    productVersion: z.string().min(1),
    generation: z.string().min(1),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const leaseDescriptor = z
  .object({ version: z.literal(1), instance: tuple, expected: lease })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    ssh: z
      .object({ alias: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u), config: absolute })
      .strict(),
    local: leaseDescriptor,
    remote: z.object({ driver: z.unknown(), lease: leaseDescriptor }).strict(),
  })
  .strict();
export function validateSparkCanonicalConfig(input: unknown) {
  const config = configSchema.parse(input);
  const driver = validateSparkDriverDescriptor(config.remote.driver);
  for (const descriptor of [config.local, config.remote.lease]) {
    validateSparkQualificationDescriptor(descriptor);
    for (const field of ["worktree", "name", "store"] as const)
      assert.equal(descriptor.instance[field], descriptor.expected[field], "Lease tuple mismatch");
  }
  assert.deepEqual(
    config.remote.lease.instance,
    driver.instance,
    "Remote driver and lease tuple mismatch",
  );
  assert.notEqual(
    config.local.expected.daemonId,
    config.remote.lease.expected.daemonId,
    "Expected two distinct owners",
  );
  assert.notEqual(config.local.instance.name, "", "Explicit local instance required");
  return { ...config, remote: { ...config.remote, driver } };
}
export function readSparkCanonicalConfig(path: string) {
  absolute.parse(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    assert(
      before.isFile() &&
        before.nlink === 1 &&
        before.uid === process.getuid!() &&
        (before.mode & 0o777) === 0o600 &&
        before.size > 0 &&
        before.size <= 65536,
      "Private runner config refused",
    );
    const bytes = Buffer.alloc(before.size + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    assert.equal(size, before.size);
    const after = fstatSync(fd);
    for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
      assert.equal(before[key], after[key]);
    return validateSparkCanonicalConfig(JSON.parse(bytes.subarray(0, size).toString("utf8")));
  } finally {
    closeSync(fd);
  }
}

const attributionStages = z.enum([
  "initialize",
  "secondary-start",
  "secondary-register",
  "secondary-discover",
  "secondary-seed",
  "scoped-operations",
  "default-clock-barrier",
]);
export function safeSparkAttributionFailureStage(value: unknown) {
  const parsed = attributionStages.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const cleanupComponents = z.enum([
  "scoped-stream",
  "legacy-stream",
  "agents",
  "catalog",
  "registration",
  "manager",
  "transport",
  "private-tmux",
  "private-files",
]);
export function safeSparkCleanupFailures(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.slice(0, 32).flatMap((entry) => {
        if (typeof entry !== "string") return [];
        const component = cleanupComponents.safeParse(entry.split(":", 1)[0]);
        return component.success ? [component.data] : [];
      }),
    ),
  ];
}
type RunnerStage =
  | "local-handshake"
  | "local-health"
  | "remote-handshake"
  | "attribution"
  | "post-health"
  | "cleanup";

/** Never creates or discovers a default daemon; both managed owners must already be ready. */
export async function qualifySparkCanonical(input: unknown, externalSignal?: AbortSignal) {
  const config = validateSparkCanonicalConfig(input);
  const { driver, lease: remoteLease } = config.remote;
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(180_000)])
    : AbortSignal.timeout(180_000);
  const children = new Map<ChildProcess, Promise<void>>();
  const retain = <T extends ChildProcess>(child: T): T => {
    children.set(child, new Promise<void>((done) => child.once("close", () => done())));
    return child;
  };
  let closing = false;
  const execute: SparkRemoteExec = (file, args, options) =>
    new Promise((done, reject) => {
      assert(!closing, "SSH transport is disposing");
      retain(
        execFile(file, args, options, (error, stdout, stderr) =>
          error ? reject(new Error("Private action failed")) : done({ stdout, stderr }),
        ),
      );
    });
  const actionTransport = createSparkRemoteAction(
    {
      root: driver.root,
      node: driver.tools.node.path,
      target: config.ssh.alias,
      config: config.ssh.config,
    },
    execute,
  );
  const actions = new Set<Promise<unknown>>();
  const runAction = (action: string, serverId?: string) => {
    const pending = actionTransport(action, serverId);
    actions.add(pending);
    void pending.then(
      () => actions.delete(pending),
      () => actions.delete(pending),
    );
    return pending;
  };
  const transports: Awaited<ReturnType<typeof openSshDaemonTransport>>[] = [];
  const translator = {
    alias: config.ssh.alias,
    config: config.ssh.config,
    node: driver.tools.node.path,
    dispatcher: `${driver.source.path}/scripts/spark-qualification-handshake.mjs`,
    descriptor: `${driver.root}/lease.json`,
    port: remoteLease.expected.port,
  };
  const connect: typeof openSshDaemonTransport = async (options) => {
    assert.equal(options.alias, config.ssh.alias);
    const transport = await openSshDaemonTransport(
      { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal },
      {
        spawn: (args) => {
          assert(!closing, "SSH transport is disposing");
          const translated = sparkQualificationSshArgs(args, translator);
          // These restrictions apply to both closed discovery and loopback forwarding.
          return retain(
            spawn(
              "/usr/bin/ssh",
              [
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "ForwardAgent=no",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                ...translated,
              ],
              {
                env: {
                  PATH: "/usr/bin:/bin",
                  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            ),
          );
        },
        allocatePort: unusedLoopbackPort,
        probe: probeSshDaemonIdentity,
      },
    );
    transports.push(transport);
    for (const [field, expected] of Object.entries({
      instanceId: remoteLease.expected.daemonId,
      pid: remoteLease.expected.pid,
      port: remoteLease.expected.port,
      startedAt: remoteLease.expected.startedAt,
      protocolVersion: remoteLease.expected.protocolVersion,
      productVersion: remoteLease.expected.productVersion,
    }))
      assert.equal(
        transport.daemon[field as keyof typeof transport.daemon],
        expected,
        "Remote handshake lease mismatch",
      );
    return transport;
  };
  const localHandshake = async () =>
    RemoteDaemonHandshakeSchema.parse(
      JSON.parse(
        await developmentSshHandshake(
          resolveDevelopmentInstance(config.local.instance),
          config.local.expected,
        ),
      ),
    ).daemon;
  let local: Awaited<ReturnType<typeof localHandshake>> | undefined;
  const localHealthy = async () => {
    assert(local, "Local handshake not admitted");
    assert.deepEqual(await localHandshake(), local, "Local managed owner changed");
    assert(
      await probeSshDaemonIdentity(
        `http://127.0.0.1:${local.port}`,
        local,
        AbortSignal.timeout(5000),
      ),
      "Local owner health failed",
    );
  };
  const facts: Record<string, unknown> = {};
  let passed = false;
  let localStillUsable = false;
  let disposed = false;
  let stage: RunnerStage = "local-handshake";
  let failureStage: RunnerStage | null = null;
  let attributionFailureStage: ReturnType<typeof safeSparkAttributionFailureStage> = null;
  try {
    local = await localHandshake();
    stage = "local-health";
    await localHealthy();
    stage = "remote-handshake";
    const initial = await connect({ alias: config.ssh.alias });
    const remote = initial.daemon;
    initial.dispose();
    await initial.closed;
    stage = "attribution";
    await qualifyCanonicalSshAttribution({
      local,
      remote,
      alias: config.ssh.alias,
      connect,
      privateParent: driver.root,
      executable: driver.tools.native.path,
      session: "attribution-collision",
      signal,
      identify: async () => {
        throw new Error("Remote adapter must own process identification");
      },
      secondary: createSparkRemoteSecondary({ root: driver.root, runAction }),
      stampRemoteDefault: async (state) => {
        assert(/^(?:blocked|done):[0-9]+$/u.test(state));
        const desired = state.startsWith("blocked:") ? "blocked" : "done";
        z.object({ stamped: z.literal(desired) })
          .strict()
          .parse(await runAction(`stamp-${desired}`));
      },
      facts,
    });
    passed = true;
  } catch {
    failureStage = stage;
    if (stage === "attribution") {
      attributionFailureStage = safeSparkAttributionFailureStage(facts.failureStage);
      if (facts.ok === true && Array.isArray(facts.cleanupErrors) && facts.cleanupErrors.length)
        failureStage = "cleanup";
    }
    // Detailed helper errors can contain private endpoint or credential-bearing data.
  } finally {
    stage = "cleanup";
    closing = true;
    for (const transport of transports) transport.dispose();
    for (const child of children.keys())
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const escalation = setTimeout(() => {
      for (const child of children.keys())
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 250);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([
          ...[...actions].map((pending) => pending.catch(() => {})),
          ...children.values(),
          ...transports.map((transport) => transport.closed),
        ]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("SSH child exit unconfirmed")), 5000);
        }),
      ]);
      disposed = true;
    } catch {
      failureStage ??= stage;
      /* Retain task records when close cannot be proved. */
    } finally {
      clearTimeout(escalation);
      if (timer) clearTimeout(timer);
    }
    if (local) {
      stage = "post-health";
      try {
        await localHealthy();
        localStillUsable = true;
      } catch {
        failureStage ??= stage;
      }
    }
  }
  return {
    version: 1,
    scope: "canonical-discovery-scoped-attribution-global-clock",
    ok: passed && localStillUsable && disposed,
    attribution: passed,
    assertionsPassed: facts.ok === true,
    cleanupFailures: safeSparkCleanupFailures(facts.cleanupErrors),
    failureStage,
    attributionFailureStage,
    localStillUsable,
    sshChildrenClosed: disposed,
    reconnectQualified: false,
    replacementQualified: false,
    nativeIdleQualified: false,
    retainManagedInstances: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    assert.equal(process.argv.length, 3, "One private runner config required");
    const result = await qualifySparkCanonical(
      readSparkCanonicalConfig(resolve(process.argv[2]!)),
      cancellation.signal,
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write(
      "Spark canonical qualification refused; retain private managed instances and records.\n",
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
