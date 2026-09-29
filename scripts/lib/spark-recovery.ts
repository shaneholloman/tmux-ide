/** Physical Home-owner recovery fixture. No retained TUI/paint qualification is implied. */
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRoot, createSignal } from "solid-js";
import { z } from "zod";
import {
  AutomationReserveResponseSchemaZ,
  AutomationExecuteResponseSchemaZ,
  type CanonicalDaemonInfo,
  type InteractionPaneEndpoint,
} from "../../packages/contracts/src/index.ts";
import {
  subscribeTmuxServerInteractions,
  type TmuxInteractionSubscription,
} from "../../packages/daemon-client/src/tmux-server-interaction-events.ts";
import { createApplicationDaemonAuthority } from "../../packages/daemon/src/tui/mirror/runtime/application-daemon-authority-owner.ts";
import { createApplicationMachineAuthorityManager } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-authority.ts";
import { createApplicationMachineCatalog } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-catalog.ts";
import { createApplicationMachineAgents } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-agents.ts";
import {
  applicationPaneActivitySources,
  createApplicationPaneActivityOwner,
  type ApplicationInteractionSource,
} from "../../packages/daemon/src/tui/mirror/runtime/application-pane-activity-owner.ts";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import { developmentSshHandshake } from "../../packages/daemon/src/lib/development-ssh.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
  RemoteDaemonHandshakeSchema,
  SshConnectionError,
} from "../../packages/daemon/src/lib/ssh-daemon-transport.ts";
import { validateSparkCanonicalConfig } from "../qualify-spark-canonical.ts";
import { createSparkRemoteAction, type SparkRemoteExec } from "./spark-remote-action.ts";
import { sparkQualificationSshArgs } from "./spark-qualification-ssh.mjs";
import { unusedLoopbackPort } from "./owned-ssh-fixture.mjs";

type AutomationPaneEndpoint = Extract<InteractionPaneEndpoint, { kind: "pane" }>;
type Config = ReturnType<typeof validateSparkCanonicalConfig>;
type Lease = Config["remote"]["lease"]["expected"];
type Connection = Awaited<ReturnType<typeof openSshDaemonTransport>>;
type Stage =
  | "local-admission"
  | "home-discovery"
  | "baseline-read"
  | "forward-loss"
  | "offline-read"
  | "home-replay"
  | "replace-owner"
  | "replacement-home"
  | "stale-endpoint"
  | "local-health"
  | "cleanup";
type FailureCode =
  | "assertion"
  | "deadline"
  | "cancelled"
  | "transport"
  | "invalid-receipt"
  | "unknown";
/** Classify only fixed error kinds; private messages and attached output never leave memory. */
export function sparkRecoveryFailureCode(error: unknown, signal?: AbortSignal): FailureCode {
  if (signal?.aborted) return signal.reason?.name === "TimeoutError" ? "deadline" : "cancelled";
  if (!(error instanceof Error)) return "unknown";
  if (
    error.name === "TimeoutError" ||
    error.message === "Recovery stage deadline" ||
    error.message === "Recovery cleanup deadline"
  )
    return "deadline";
  if (error.name === "AbortError") return "cancelled";
  if (error instanceof assert.AssertionError) return "assertion";
  if (error instanceof z.ZodError || error instanceof SyntaxError) return "invalid-receipt";
  if (
    error instanceof SshConnectionError ||
    error.message === "fetch failed" ||
    error.message === "Private action refused" ||
    error.message ===
      "Private Spark action outcome is unconfirmed; retain task records and do not rerun automatically"
  )
    return "transport";
  return "unknown";
}
export function validateSparkRecoveryReplacement(config: Config, value: unknown): Lease {
  const parsed = z
    .object({
      replaced: z.literal(true),
      lease: z.unknown(),
      tmuxPreserved: z.literal(true),
      staleLeaseRejected: z.literal(true),
    })
    .strict()
    .parse(value);
  const next = validateSparkCanonicalConfig({
    ...config,
    remote: { ...config.remote, lease: { ...config.remote.lease, expected: parsed.lease } },
  }).remote.lease.expected;
  const before = config.remote.lease.expected;
  assert.equal(next.instanceId, before.instanceId, "Managed instance changed");
  assert.notEqual(next.daemonId, before.daemonId, "Daemon generation did not change");
  assert.notEqual(next.pid, before.pid, "Replacement reused the recorded daemon PID");
  assert.notEqual(next.startedAt, before.startedAt, "Replacement start did not change");
  return next;
}

/** Must execute with the client Solid runtime, as configured by the opt-in fixture. */
export interface SparkRetainedTuiObserver {
  baseline(): Promise<void>;
  forwardLost(): Promise<void>;
  forwarded(): Promise<void>;
  replaced(lease: Lease): Promise<void>;
  close(): Promise<void>;
}

export async function qualifySparkHomeRecovery(options: {
  config: unknown;
  retainedTui?: SparkRetainedTuiObserver;
  signal: AbortSignal;
  identify(pid: number): Promise<string | null>;
  persistReplacementLease(lease: Lease): void | Promise<void>;
}) {
  const config = validateSparkCanonicalConfig(options.config);
  const driver = config.remote.driver;
  let lease = config.remote.lease.expected;
  let stage: Stage = "local-admission";
  let failureStage: Stage | null = null;
  let failureCode: FailureCode | null = null;
  const proof = {
    reconnect: false,
    automaticHomeCursor: false,
    offlineReadReplayed: false,
    historyPreserved: false,
    replacement: false,
    staleEndpointRejected: false,
    localStillUsable: false,
    cleanup: false,
  };
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(240000)]);
  const fail = (error: unknown, failedStage: Stage) => {
    if (failureStage !== null) return;
    failureStage = failedStage;
    failureCode = sparkRecoveryFailureCode(error, signal);
  };
  const wait = async (predicate: () => boolean, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      signal.throwIfAborted();
      assert(Date.now() < deadline, "Recovery stage deadline");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const bound = async <T>(work: Promise<T>, ms = 5000) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("Recovery cleanup deadline")), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const children = new Map<ChildProcess, Promise<void>>();
  const retain = <T extends ChildProcess>(child: T) => {
    children.set(child, new Promise<void>((resolve) => child.once("close", resolve)));
    assert(children.size <= 128, "Bounded SSH child inventory exceeded");
    return child;
  };
  const transports: Connection[] = [];
  const subscriptions: {
    source: ApplicationInteractionSource;
    resume: number | null;
    stream: TmuxInteractionSubscription;
  }[] = [];
  let closing = false;
  let gate: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const hold = () => {
    assert(!gate);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const resume = () => {
    const done = release;
    gate = null;
    release = null;
    done?.();
  };
  let primary: { child: ChildProcess; witness: string; transport: Connection } | null = null;
  const execute: SparkRemoteExec = (file, args, execOptions) =>
    new Promise((resolve, reject) => {
      assert(!closing);
      retain(
        execFile(file, args, execOptions, (error, stdout, stderr) =>
          error ? reject(Error("Private action refused")) : resolve({ stdout, stderr }),
        ),
      );
    });
  const action = createSparkRemoteAction(
    {
      root: driver.root,
      node: driver.tools.node.path,
      target: config.ssh.alias,
      config: config.ssh.config,
    },
    execute,
  );
  const dial = async (
    input: Parameters<typeof openSshDaemonTransport>[0],
    witnessOnly = false,
  ): Promise<Connection> => {
    assert.equal(input.alias, config.ssh.alias);
    if (!witnessOnly && gate) await bound(gate, 90000);
    assert(!closing);
    signal.throwIfAborted();
    const expected = lease;
    let forward: ChildProcess | undefined;
    const transport = await openSshDaemonTransport(
      { ...input, signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal },
      {
        allocatePort: unusedLoopbackPort,
        probe: probeSshDaemonIdentity,
        spawn: (args) => {
          assert(!closing);
          const translated = sparkQualificationSshArgs(args, {
            alias: config.ssh.alias,
            config: config.ssh.config,
            node: driver.tools.node.path,
            dispatcher: `${driver.source.path}/scripts/spark-qualification-handshake.mjs`,
            descriptor: `${driver.root}/lease.json`,
            port: expected.port,
          });
          const child = retain(
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
          if (args.includes("-L")) {
            assert(!forward);
            forward = child;
          }
          return child;
        },
      },
    );
    transports.push(transport);
    if (closing) {
      transport.dispose();
      throw Error("Recovery fixture is closing");
    }
    assert(transports.length <= 64, "Bounded SSH connection inventory exceeded");
    assert.equal(transport.daemon.instanceId, expected.daemonId);
    assert.equal(transport.daemon.pid, expected.pid);
    assert.equal(transport.daemon.port, expected.port);
    assert.equal(transport.daemon.startedAt, expected.startedAt);
    assert(forward?.pid);
    const witness = await options.identify(forward.pid);
    assert(witness);
    if (!witnessOnly) primary = { child: forward, witness, transport };
    return transport;
  };
  const flights = new Set<Promise<Connection>>();
  const connect = (input: Parameters<typeof openSshDaemonTransport>[0], witnessOnly = false) => {
    const pending = dial(input, witnessOnly);
    flights.add(pending);
    void pending.then(
      () => flights.delete(pending),
      () => flights.delete(pending),
    );
    return pending;
  };
  const json = async (
    connection: Pick<Connection, "baseUrl" | "daemon">,
    path: string,
    body?: unknown,
  ) => {
    const response = await fetch(connection.baseUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${connection.daemon.authToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    assert(response.body);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        assert(size <= 1024 * 1024);
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return { status: response.status, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  };
  const read = async (
    connection: Pick<Connection, "baseUrl" | "daemon">,
    target: AutomationPaneEndpoint,
  ) => {
    const intent = { kind: "read", target, source: null };
    const reserved = await json(connection, "/api/v1/automation/reserve", { version: 1, intent });
    assert.equal(reserved.status, 201);
    const { handle } = AutomationReserveResponseSchemaZ.parse(reserved.value);
    const executed = await json(connection, "/api/v1/automation/execute", {
      version: 1,
      intent,
      handle,
    });
    assert.equal(executed.status, 200);
    const result = AutomationExecuteResponseSchemaZ.parse(executed.value);
    assert.deepEqual(result.handle, handle);
    assert.equal(result.result.kind, "read");
    assert.equal(result.read?.availability, "available");
    return handle.operationId;
  };
  let local: CanonicalDaemonInfo | undefined;
  const localHandshake = async () =>
    RemoteDaemonHandshakeSchema.parse(
      JSON.parse(
        await developmentSshHandshake(
          resolveDevelopmentInstance(config.local.instance),
          config.local.expected,
        ),
      ),
    ).daemon;
  const localHealth = async () => {
    assert(local);
    assert.deepEqual(await localHandshake(), local);
    assert(
      await probeSshDaemonIdentity(
        `http://127.0.0.1:${local.port}`,
        local as RemoteDaemonHandshakeSchemaType,
        AbortSignal.timeout(5000),
      ),
    );
  };
  type RemoteDaemonHandshakeSchemaType = Connection["daemon"];
  let manager: ReturnType<typeof createApplicationMachineAuthorityManager> | undefined;
  let catalog: ReturnType<typeof createApplicationMachineCatalog> | undefined;
  let agents: ReturnType<typeof createApplicationMachineAgents> | undefined;
  let disposeHome: (() => void) | undefined;
  const stops: (() => void)[] = [];
  try {
    local = await localHandshake();
    await localHealth();
    manager = createApplicationMachineAuthorityManager({
      createOwner: () =>
        createApplicationDaemonAuthority({
          readLocal: () => local!,
          isLocalAlive: async () => {
            await localHealth();
            return true;
          },
          observeLocal: async () => () => {},
          verify: probeSshDaemonIdentity,
          connect: (input) => connect(input),
        }),
    });
    catalog = createApplicationMachineCatalog({ manager });
    agents = createApplicationMachineAgents({ manager, catalog });
    const route = randomUUID();
    const home = createRoot((dispose) => {
      disposeHome = dispose;
      const [sources, setSources] = createSignal<readonly ApplicationInteractionSource[]>([]);
      const activity = createApplicationPaneActivityOwner(sources, (input) => {
        assert(subscriptions.length < 128, "Bounded activity connection inventory exceeded");
        const stream = subscribeTmuxServerInteractions(input);
        subscriptions.push({
          source: {
            environmentId: "",
            server: input.server,
            baseUrl: input.baseUrl,
            ownerToken: input.ownerToken,
          },
          resume: input.resume?.cursor ?? null,
          stream,
        });
        return stream;
      });
      return { activity, setSources };
    });
    const update = () =>
      home.setSources(
        applicationPaneActivitySources(
          catalog!.getSnapshot().groups.map((group) => ({
            ...group,
            agents: agents!.getSnapshot().find((item) => item.machineId === group.id)?.agents ?? [],
          })),
          "local",
          [],
          (id) => manager!.getMachine(id)?.read(),
        ),
      );
    stops.push(catalog.subscribe(update), agents.subscribe(update), manager.subscribe(update));
    manager.initialize([
      { id: route, label: "Private Spark recovery", sshTarget: config.ssh.alias, enabled: true },
    ]);
    catalog.start();
    agents.start();
    stage = "home-discovery";
    assert(await manager.getMachine(route)!.ready);
    const handle = manager.getMachine(route)!;
    const endpoint = (id: string) =>
      agents!
        .getSnapshot()
        .find((group) => group.machineId === id && group.available)
        ?.agents.find((agent) => agent.sessionName === "attribution-collision")
        ?.interactionEndpoint;
    await wait(() => !!endpoint("local") && !!endpoint(route) && subscriptions.length >= 2);
    const target = endpoint(route)!;
    assert.equal(target.semanticPaneId, "pane.shared");
    const current = () => {
      const daemon = handle.read();
      const baseUrl = handle.endpoint().localBaseUrl;
      assert(daemon?.authToken && baseUrl);
      return { daemon: daemon as Connection["daemon"], baseUrl };
    };
    const has = (id: string) =>
      home.activity
        .activity()
        .some(
          (entry) =>
            entry.type === "interaction.receipt" &&
            entry.operationId === id &&
            entry.phase === "observed",
        );
    await bound(options.retainedTui?.baseline() ?? Promise.resolve(), 60000);
    stage = "baseline-read";
    const baseline = await read(current(), target);
    await wait(() => has(baseline));
    const before = home.activity
      .activity()
      .find((entry) => entry.type === "interaction.receipt" && entry.operationId === baseline)!;
    const original = current();
    const originalSubscription = subscriptions.findLast(
      (item) =>
        item.source.server.serverId === target.serverScope.serverId &&
        item.source.baseUrl === original.baseUrl,
    )!;
    await wait(() => originalSubscription.stream.getCursor().cursor >= before.sequence);
    const witness = await connect({ alias: config.ssh.alias }, true);
    stage = "forward-loss";
    hold();
    await bound(options.retainedTui?.forwardLost() ?? Promise.resolve());
    const currentPrimary = (): typeof primary => primary;
    const interrupted = currentPrimary();
    assert(interrupted?.child.pid);
    assert.equal(await options.identify(interrupted.child.pid), interrupted.witness);
    assert(interrupted.child.kill("SIGTERM"));
    await bound(children.get(interrupted.child)!);
    assert.equal(await options.identify(interrupted.child.pid), null);
    await wait(() => handle.endpoint().state !== "ready");
    await Promise.resolve();
    await bound(originalSubscription.stream.done.catch(() => {}));
    const savedCursor = originalSubscription.stream.getCursor().cursor;
    assert(savedCursor >= before.sequence);
    stage = "offline-read";
    assert.equal(
      home.activity
        .activity()
        .find((entry) => entry.type === "interaction.receipt" && entry.operationId === baseline),
      before,
    );
    const offline = await read(witness, target);
    assert.notEqual(handle.endpoint().state, "ready");
    const localOperation = await read(
      { baseUrl: `http://127.0.0.1:${local.port}`, daemon: local as Connection["daemon"] },
      endpoint("local")!,
    );
    await wait(() => has(localOperation));
    await localHealth();
    stage = "home-replay";
    resume();
    await wait(() => handle.endpoint().state === "ready", 45000);
    assert.equal(current().daemon.instanceId, original.daemon.instanceId);
    assert.notEqual(current().baseUrl, original.baseUrl);
    await wait(() => has(offline));
    const resumed = subscriptions.findLast(
      (item) =>
        item.source.baseUrl === current().baseUrl &&
        item.source.server.serverId === target.serverScope.serverId,
    )!;
    assert.equal(resumed.resume, savedCursor);
    assert.equal(
      home.activity
        .activity()
        .find((entry) => entry.type === "interaction.receipt" && entry.operationId === baseline),
      before,
    );
    for (const id of [baseline, offline])
      assert.equal(
        home.activity
          .activity()
          .filter((entry) => entry.type === "interaction.receipt" && entry.operationId === id)
          .length,
        1,
      );
    proof.reconnect =
      proof.automaticHomeCursor =
      proof.offlineReadReplayed =
      proof.historyPreserved =
        true;
    await bound(options.retainedTui?.forwarded() ?? Promise.resolve(), 60000);
    stage = "replace-owner";
    hold();
    const replacement = validateSparkRecoveryReplacement(config, await action("replace-owner"));
    await options.persistReplacementLease(replacement);
    lease = replacement;
    await bound(options.retainedTui?.replaced(replacement) ?? Promise.resolve(), 60000);
    resume();
    stage = "replacement-home";
    await wait(
      () =>
        handle.read()?.instanceId === replacement.daemonId &&
        !!endpoint(route) &&
        endpoint(route)!.serverScope.generation !== target.serverScope.generation,
      60000,
    );
    const nextTarget = endpoint(route)!;
    await wait(() =>
      subscriptions.some(
        (item) => item.source.server.generation === nextTarget.serverScope.generation,
      ),
    );
    const fresh = subscriptions.findLast(
      (item) => item.source.server.generation === nextTarget.serverScope.generation,
    )!;
    assert.equal(fresh.resume, null);
    assert(
      !home.activity
        .activity()
        .some(
          (entry) =>
            entry.type === "interaction.receipt" && [baseline, offline].includes(entry.operationId),
        ),
    );
    const nextRead = await read(current(), nextTarget);
    await wait(() => has(nextRead));
    proof.replacement = true;
    stage = "stale-endpoint";
    const stale = await json(current(), "/api/v1/automation/reserve", {
      version: 1,
      intent: { kind: "read", target, source: null },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.value.error?.code, "invalid-target");
    const retiredScope = await json(
      current(),
      `/api/v1/tmux-servers/${target.serverScope.serverId}/${target.serverScope.generation}/interaction-events?after=0`,
    );
    assert.equal(retiredScope.status, 409);
    assert.equal(retiredScope.value.error?.code, "stale-generation");
    assert.equal(
      await probeSshDaemonIdentity(current().baseUrl, original.daemon, AbortSignal.timeout(5000)),
      false,
    );
    proof.staleEndpointRejected = true;
    stage = "local-health";
    await localHealth();
    proof.localStillUsable = true;
  } catch (error) {
    fail(error, stage);
  } finally {
    closing = true;
    let cleanupFailed = false;
    try {
      await bound(options.retainedTui?.close() ?? Promise.resolve(), 10000);
    } catch (error) {
      cleanupFailed = true;
      fail(error, "cleanup");
    }
    const safe = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        cleanupFailed = true;
        fail(error, "cleanup");
      }
    };
    stops.forEach((stop) => safe(stop));
    safe(() => disposeHome?.());
    safe(() => agents?.dispose());
    safe(() => catalog?.dispose());
    safe(() => manager?.dispose());
    resume();
    transports.forEach((transport) => safe(() => transport.dispose()));
    const stopChildren = (kind: NodeJS.Signals) =>
      children.forEach((_, child) =>
        safe(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill(kind);
        }),
      );
    stopChildren("SIGTERM");
    const escalation = setTimeout(() => stopChildren("SIGKILL"), 250);
    try {
      await bound(
        Promise.all([
          ...[...flights].map((pending) => pending.catch(() => {})),
          ...children.values(),
          ...transports.map((transport) => transport.closed),
          ...subscriptions.map(({ stream }) => stream.done.catch(() => {})),
        ]),
      );
      proof.cleanup = !cleanupFailed;
    } catch (error) {
      fail(error, "cleanup");
    } finally {
      clearTimeout(escalation);
    }
    if (local) {
      try {
        await localHealth();
        proof.localStillUsable = true;
      } catch (error) {
        proof.localStillUsable = false;
        fail(error, "local-health");
      }
    }
  }
  return {
    version: 1,
    scope: "physical-home-owner-reconnect-replay-replacement",
    ok: Object.values(proof).every(Boolean),
    ...proof,
    failureStage,
    failureCode,
    retainedTuiQualified: false,
    nativeIdleQualified: false,
    managedCleanupRequired: true,
  };
}
