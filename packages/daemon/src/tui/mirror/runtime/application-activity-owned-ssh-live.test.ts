/** Opt-in local real-SSH composition; not canonical bootstrap or cross-machine qualification. */
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRoot, createSignal } from "solid-js";
import { expect, it } from "vitest";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  type CanonicalDaemonInfo,
  type AutomationPanesResponse,
} from "@tmux-ide/contracts";
import { subscribeTmuxServerInteractions } from "@tmux-ide/daemon-client/tmux-server-interaction-events";
import { interactionPaneEndpointKey } from "@tmux-ide/core";
import { createApp } from "../../../command-center/server.ts";
import {
  createNativeTmuxServerOwner,
  type NativeTmuxServerOwner,
} from "../../../lib/tmux-server-owner.ts";
import { TmuxServerOwners } from "../../../lib/tmux-server-owners.ts";
import { createTmuxServerProbe } from "../../../lib/tmux-server-registration.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
} from "../../../lib/ssh-daemon-transport.ts";
import { createApplicationDaemonAuthority } from "./application-daemon-authority-owner.ts";
import { createApplicationMachineAuthorityManager } from "./application-machine-authority.ts";
import {
  applicationPaneActivitySources,
  createApplicationPaneActivityOwner,
  type ApplicationInteractionSource,
} from "./application-pane-activity-owner.ts";
// Existing private fixture is JavaScript and deliberately outside published packages.
// @ts-expect-error fixture has no public declaration surface
import {
  createOwnedSshFixture,
  createMacProcessIdentity,
  ownedProcesses,
  unusedLoopbackPort,
  waitForPort,
} from "../../../../../../scripts/lib/owned-ssh-fixture.mjs";

const enabled = process.env.TMUX_IDE_OWNED_ACTIVITY_SSH === "1" && process.platform === "darwin";
const wait = async (predicate: () => boolean, label: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Deadline: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
type Endpoint = AutomationPanesResponse["panes"][number]["endpoint"];
it.skipIf(!enabled)(
  "qualifies scoped Home activity through owned real SSH with independent tmux owners",
  async () => {
    const previousUmask = process.umask(0o077);
    const root = mkdtempSync(join(realpathSync(tmpdir()), "h-"));
    const report: Record<string, unknown> = {
      kind: "local-real-ssh-composition",
      journalCapacity: 256,
    };
    const allocations: Array<{ disposeFiles(): Promise<void>; diagnostics?(): unknown }> = [];
    let kernel: { identify(pid: number): Promise<string | null> };
    const tracker = ownedProcesses({
      identify: (pid: number) => kernel.identify(pid),
      list: async () =>
        execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((line) => {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            return { pid, ppid };
          }),
    });
    const executable = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
    const sockets: string[] = [];
    const tmuxWitnesses = new Map<
      string,
      {
        observation: NonNullable<Awaited<ReturnType<ReturnType<typeof createTmuxServerProbe>>>>;
        pid: number;
        kernel: string;
      }
    >();
    const servers: ReturnType<typeof serve>[] = [];
    const registries: TmuxServerOwners<NativeTmuxServerOwner>[] = [];
    const transports: Awaited<ReturnType<typeof openSshDaemonTransport>>[] = [];
    const subscriptions: ReturnType<typeof subscribeTmuxServerInteractions>[] = [];
    const managers: ReturnType<typeof createApplicationMachineAuthorityManager>[] = [];
    let disposeHome = () => {};
    let primaryFailure: unknown;
    let teardownFailure: unknown;
    const run = (socket: string, args: string[]) =>
      execFileSync(executable, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TMUX: "", TMUX_IDE_NATIVE_INTERACTIONS: "0" },
      }).trim();
    async function retainTmux(socket: string) {
      const observation = await createTmuxServerProbe(executable)({ kind: "path", path: socket });
      if (!observation?.nativeServerIdentity) throw Error("Private tmux identity unavailable");
      const pid = Number(observation.nativeServerIdentity.pid);
      let witness: string | null = null;
      const deadline = Date.now() + 1500;
      while (!witness && Date.now() < deadline) {
        try {
          witness = await kernel.identify(pid);
        } catch {
          /* Startup probe remains unadmitted. */
        }
        if (!witness) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const confirmed = await createTmuxServerProbe(executable)({ kind: "path", path: socket });
      if (confirmed?.fingerprint !== observation.fingerprint)
        throw Error("Private tmux changed during kernel admission");
      if (!witness || !observation.valid()) throw Error("Private tmux kernel witness unavailable");
      tmuxWitnesses.set(socket, { observation, pid, kernel: witness });
    }
    async function stopTmux(socket: string) {
      const owned = tmuxWitnesses.get(socket);
      if (!owned) throw Error("Private tmux has no retained ownership proof");
      const currentKernel = await kernel.identify(owned.pid);
      if (currentKernel === null) {
        tmuxWitnesses.delete(socket);
        return;
      }
      if (currentKernel !== owned.kernel || !owned.observation.valid())
        throw Error("Private tmux identity changed; cleanup refused");
      const current = await createTmuxServerProbe(executable)({ kind: "path", path: socket });
      if (!current || current.fingerprint !== owned.observation.fingerprint)
        throw Error("Private tmux PID/start changed; cleanup refused");
      const identity = owned.observation.nativeServerIdentity!;
      // Evaluated in the selected server: replacement between probe and dispatch cannot be killed.
      const guard = `#{&&:#{==:#{pid},${identity.pid}},#{==:#{start_time},${identity.startTime}}}`;
      const result = run(socket, [
        "if-shell",
        "-F",
        guard,
        "kill-server",
        "display-message -p identity-mismatch",
      ]);
      if (result) throw Error("Private tmux kill guard refused");
      const end = Date.now() + 3000;
      while ((await kernel.identify(owned.pid)) !== null) {
        if (Date.now() >= end) throw Error("Private tmux exit not confirmed");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      tmuxWitnesses.delete(socket);
    }
    async function backend(name: string, count: number) {
      const environmentId = randomUUID(),
        instanceId = randomUUID(),
        authToken = randomUUID(),
        startedAt = new Date().toISOString();
      const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
        probe: createTmuxServerProbe(executable),
        create: (registration, scope, observation) =>
          createNativeTmuxServerOwner({
            ...scope,
            environmentId,
            tmuxAuthority: observation.authority,
            nativeServerIdentity: observation.nativeServerIdentity,
            stateDirectory: join(root, name, registration.serverId),
            webSocketUrl: "ws://127.0.0.1:1/v2/terminal/pane-streams/redeem",
          }),
      });
      registries.push(owners);
      const ownSockets = [];
      for (let n = 0; n < count; n++) {
        const socket = join(root, `${name}-${n}.sock`);
        sockets.push(socket);
        ownSockets.push(socket);
        run(socket, ["new-session", "-d", "-s", "attribution-collision", "cat"]);
        await retainTmux(socket);
        run(socket, [
          "set-option",
          "-p",
          "-t",
          "attribution-collision:0.0",
          "@tmux_ide_pane_id",
          "pane.shared",
        ]);
        await owners.register({ label: `${name}-${n}`, selector: { kind: "path", path: socket } });
      }
      const app = createApp({
        tmuxServerOwners: owners,
        remoteAccess: { ownerToken: authToken },
        daemonIdentity: {
          instanceId,
          startedAt,
          environmentId,
          productVersion: "owned-attribution-fixture",
        },
        catalogLiveSessions: () => [],
        catalogFleet: () => [],
      });
      const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
      servers.push(server);
      await wait(() => !!server.address(), "HTTP ready");
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Bad listener");
      const info: CanonicalDaemonInfo = {
        pid: process.pid,
        port: address.port,
        bindHostname: "127.0.0.1",
        instanceId,
        environmentId,
        startedAt,
        authToken,
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
        productVersion: "owned-attribution-fixture",
      };
      return { owners, info, ownSockets, url: `http://127.0.0.1:${address.port}` };
    }
    async function json(base: string, token: string, path: string, body?: unknown) {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      const value = await response.json();
      expect(response.ok, JSON.stringify(value)).toBe(true);
      return value;
    }
    async function discover(
      b: Awaited<ReturnType<typeof backend>>,
      url = b.url,
    ): Promise<Endpoint[]> {
      return (await json(url, b.info.authToken!, "/api/v1/automation/panes")).panes.map(
        (pane: AutomationPanesResponse["panes"][number]) => pane.endpoint,
      );
    }
    async function read(b: Awaited<ReturnType<typeof backend>>, target: Endpoint) {
      const intent = { kind: "read", target, source: null };
      const { handle } = await json(b.url, b.info.authToken!, "/api/v1/automation/reserve", {
        version: 1,
        intent,
      });
      await json(b.url, b.info.authToken!, "/api/v1/automation/execute", {
        version: 1,
        handle,
        intent,
      });
      return handle.operationId as string;
    }
    try {
      kernel = await createMacProcessIdentity({
        parent: root,
        onAllocated: (owner: (typeof allocations)[number]) => allocations.push(owner),
      });
      const local = await backend("local", 1),
        remote = await backend("remote", 2);
      const fixture = await createOwnedSshFixture({
        parent: root,
        node: process.execPath,
        targetPort: remote.info.port,
        processes: tracker,
        handshake: () => ({ version: 1, daemon: remote.info }),
        onAllocated: (owner: (typeof allocations)[number]) => allocations.push(owner),
      });
      const created: ReturnType<typeof createApplicationDaemonAuthority>[] = [];
      const forwardingChildren = new Map<string, ReturnType<typeof spawn>>();
      const makeManager = () => {
        const manager = createApplicationMachineAuthorityManager({
          createOwner: () => {
            const owner = createApplicationDaemonAuthority({
              readLocal: () => local.info,
              isLocalAlive: async () => true,
              observeLocal: async () => () => {},
              verify: probeSshDaemonIdentity,
              retryDelayMs: 100,
              probeIntervalMs: 200,
              connect: async (options) => {
                let forwarding: ReturnType<typeof spawn> | undefined;
                const transport = await openSshDaemonTransport(options, {
                  spawn: (args) => {
                    const child = tracker.retain(
                      spawn("/usr/bin/ssh", ["-F", fixture.config, ...args], {
                        stdio: ["ignore", "pipe", "pipe"],
                      }),
                    );
                    if (args.includes("-N")) forwarding = child;
                    return child;
                  },
                  allocatePort: unusedLoopbackPort,
                  probe: probeSshDaemonIdentity,
                });
                transports.push(transport);
                if (!forwarding) throw Error("Expected owned SSH forwarding child");
                forwardingChildren.set(transport.baseUrl, forwarding);
                return transport;
              },
            });
            created.push(owner);
            return owner;
          },
        });
        managers.push(manager);
        return manager;
      };
      const first = makeManager(),
        second = makeManager(),
        route = randomUUID(),
        alias = randomUUID();
      const profile = { id: route, label: "Private SSH", sshTarget: "target", enabled: true };
      first.initialize([profile, { ...profile, id: alias, label: "Second private route" }]);
      second.initialize([profile]);
      const ready = await Promise.all([
        first.getMachine(route)!.ready,
        first.getMachine(alias)!.ready,
        second.getMachine(route)!.ready,
      ]);
      report.authorities = created.map((owner) => ({
        state: owner.endpoint().state,
        diagnostic: owner.endpoint().diagnostic,
      }));
      expect(ready).toEqual([true, true, true]);
      expect(first.snapshot().selectedMachineId).toBe("local");
      await tracker.capture();
      const localEndpoints = await discover(local);
      let remoteEndpoints = await discover(
        remote,
        first.getMachine(route)!.endpoint().localBaseUrl!,
      );
      expect(localEndpoints).toHaveLength(1);
      expect(remoteEndpoints).toHaveLength(2);
      expect(
        new Set([...localEndpoints, ...remoteEndpoints].map((e) => e.semanticPaneId)).size,
      ).toBe(1);
      const sources = () =>
        applicationPaneActivitySources(
          [
            {
              id: "local",
              state: "ready",
              environmentId: local.info.environmentId,
              agents: localEndpoints.map((interactionEndpoint) => ({ interactionEndpoint })),
            },
            ...[route, alias].map((id) => ({
              id,
              state: first.getMachine(id)!.endpoint().state,
              environmentId: remote.info.environmentId,
              agents: remoteEndpoints.map((interactionEndpoint) => ({ interactionEndpoint })),
            })),
          ],
          "local",
          [],
          (id) => first.getMachine(id)?.read(),
        );
      const initial = sources();
      expect(initial).toHaveLength(3);
      const home = createRoot((dispose) => {
        disposeHome = dispose;
        const [value, set] = createSignal<readonly ApplicationInteractionSource[]>(initial);
        return { activity: createApplicationPaneActivityOwner(value), set };
      });
      const ids = [
        await read(local, localEndpoints[0]!),
        await read(remote, remoteEndpoints[0]!),
        await read(remote, remoteEndpoints[1]!),
      ];
      await wait(
        () =>
          ids.every((id) =>
            home.activity
              .activity()
              .some((entry) => entry.type === "interaction.receipt" && entry.operationId === id),
          ),
        "all owners in Home",
      );
      expect([...home.activity().keys()].sort()).toEqual(
        [...localEndpoints, ...remoteEndpoints].map(interactionPaneEndpointKey).sort(),
      );
      report.endpoints = [...localEndpoints, ...remoteEndpoints];
      report.operationIds = ids;
      const beforeReplay = home.activity
        .activity()
        .find((entry) => entry.type === "interaction.receipt" && entry.operationId === ids[1]);
      expect(beforeReplay).toBeDefined();
      for (const [backend, endpoints] of [
        [local, localEndpoints],
        [remote, remoteEndpoints],
      ] as const) {
        for (const socket of backend.ownSockets) {
          run(socket, ["capture-pane", "-p", "-t", "attribution-collision:0.0"]);
          run(socket, ["send-keys", "-t", "attribution-collision:0.0", "-l", "stock-probe"]);
        }
        for (const endpoint of endpoints) {
          const status = backend.owners
            .current(endpoint.serverScope)
            .interactionObservation!.getSnapshot();
          expect(status.method).toBe("stock-hooks");
          expect(status.coverage).toBe("partial");
        }
      }
      await wait(
        () =>
          home.activity
            .activity()
            .some((entry) => entry.type === "interaction.receipt" && entry.origin === "external"),
        "raw stock observation",
      );
      for (const entry of home.activity.activity())
        if (entry.type === "interaction.receipt" && entry.origin === "external") {
          expect(entry.evidence.actor.kind).toBe("unknown");
          expect(entry.evidence.effect.kind).toBe("unknown");
        }
      const cursorStream = subscribeTmuxServerInteractions({
        baseUrl: first.getMachine(route)!.endpoint().localBaseUrl!,
        ownerToken: remote.info.authToken!,
        server: remoteEndpoints[0]!.serverScope,
        onBatch: () => {},
      });
      subscriptions.push(cursorStream);
      await cursorStream.ready;
      await wait(() => cursorStream.getCursor().cursor > 0, "initial cursor");
      const resume = cursorStream.getCursor();
      cursorStream.close();
      await cursorStream.done;
      // Retire the first manager's two owned routes; independent client and daemon stay alive.
      const remoteAuthorities = created
        .filter((owner) => owner.endpoint().kind === "ssh")
        .slice(0, 2);
      remoteAuthorities.forEach((owner) => owner.disconnect());
      home.set(sources());
      const offline = [
        await read(remote, remoteEndpoints[0]!),
        await read(remote, remoteEndpoints[0]!),
      ];
      const localDuring = await read(local, localEndpoints[0]!);
      await wait(
        () =>
          home.activity
            .activity()
            .some((e) => e.type === "interaction.receipt" && e.operationId === localDuring),
        "local during SSH outage",
      );
      expect(await second.getMachine(route)!.isAlive(second.getMachine(route)!.read()!)).toBe(true);
      await Promise.all(remoteAuthorities.map((owner) => owner.retry()));
      await wait(
        () => remoteAuthorities.every((owner) => owner.endpoint().state === "ready"),
        "SSH reconnect",
      );
      home.set(sources());
      await wait(
        () =>
          offline.every((id) =>
            home.activity
              .activity()
              .some((e) => e.type === "interaction.receipt" && e.operationId === id),
          ),
        "retained rebuild",
      );
      const rebuilt = home.activity
        .activity()
        .find((entry) => entry.type === "interaction.receipt" && entry.operationId === ids[1]);
      expect(rebuilt).toEqual(beforeReplay);
      report.replayPreservedOriginalTimestamp = true;
      const replay: number[] = [];
      const replayStream = subscribeTmuxServerInteractions({
        baseUrl: first.getMachine(route)!.endpoint().localBaseUrl!,
        ownerToken: remote.info.authToken!,
        server: resume.server,
        resume,
        onBatch: (batch) => {
          replay.push(...batch.receipts.map((r) => r.sequence));
        },
      });
      subscriptions.push(replayStream);
      await replayStream.ready;
      await wait(() => replay.length >= 4, "same-owner replay");
      expect(new Set(replay).size).toBe(replay.length);
      expect(replay.every((n) => n > resume.cursor)).toBe(true);
      replayStream.close();
      await replayStream.done;
      // Separate real forwarding-child failure: automatic authority recovery, no daemon restart.
      const beforeLoss = first.getMachine(route)!.endpoint();
      fixture.setMode("stall");
      const lostChild = forwardingChildren.get(beforeLoss.localBaseUrl!)!;
      expect(lostChild.kill("SIGTERM")).toBe(true);
      await wait(
        () => first.getMachine(route)!.endpoint().state !== "ready",
        "forward process loss",
      );
      expect(await second.getMachine(route)!.isAlive(second.getMachine(route)!.read()!)).toBe(true);
      fixture.setMode("normal");
      await wait(
        () => first.getMachine(route)!.endpoint().state === "ready",
        "automatic transport reconnect",
        30_000,
      );
      expect(first.getMachine(route)!.endpoint().epoch).toBeGreaterThan(beforeLoss.epoch);
      expect(first.getMachine(route)!.read()!.instanceId).toBe(remote.info.instanceId);
      report.forwardProcessLossRecovered = true;
      home.set(sources());
      // Production ring capacity is 256. Real authored reads produce accepted/completed entries.
      home.set(sources().filter((source) => source.environmentId === local.info.environmentId));
      let lastFlood = "";
      for (let n = 0; n < 130; n++) lastFlood = await read(remote, remoteEndpoints[0]!);
      home.set(sources());
      await wait(
        () =>
          home.activity
            .activity()
            .some(
              (entry) => entry.type === "interaction.receipt" && entry.operationId === lastFlood,
            ),
        "Home rebuild after retention loss",
      );
      expect(home.activity.activity().length).toBeLessThanOrEqual(64);
      let gap: unknown = null;
      const gapStream = subscribeTmuxServerInteractions({
        baseUrl: first.getMachine(route)!.endpoint().localBaseUrl!,
        ownerToken: remote.info.authToken!,
        server: resume.server,
        resume,
        onBatch: (batch) => {
          if (batch.gap) gap = batch.gap;
        },
      });
      subscriptions.push(gapStream);
      await gapStream.ready;
      await wait(() => gap !== null, "retention gap through SSH");
      report.gap = gap;
      const old = remoteEndpoints[1]!;
      const socket = remote.ownSockets[1]!;
      await stopTmux(socket);
      run(socket, ["new-session", "-d", "-s", "attribution-collision", "cat"]);
      await retainTmux(socket);
      run(socket, [
        "set-option",
        "-p",
        "-t",
        "attribution-collision:0.0",
        "@tmux_ide_pane_id",
        "pane.shared",
      ]);
      remoteEndpoints = await discover(remote);
      const replacement = remoteEndpoints.find(
        (e) => e.serverScope.serverId === old.serverScope.serverId,
      )!;
      expect(replacement.serverScope.generation).not.toBe(old.serverScope.generation);
      expect(replacement.paneLifetimeId).not.toBe(old.paneLifetimeId);
      home.set(sources());
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(home.activity().has(interactionPaneEndpointKey(old))).toBe(false);
      const replacementId = await read(remote, replacement);
      await wait(
        () =>
          home.activity
            .activity()
            .some((e) => e.type === "interaction.receipt" && e.operationId === replacementId),
        "new incarnation",
      );
      report.replacement = replacement;
      report.replay = replay;
      report.outcome = "passed";
      first.dispose();
      expect(await second.getMachine(route)!.isAlive(second.getMachine(route)!.read()!)).toBe(true);
    } catch (error) {
      report.outcome = "failed";
      report.error = error instanceof Error ? error.message : String(error);
      primaryFailure = error;
    } finally {
      const cleanupErrors: Array<{ stage: string; message: string }> = [];
      async function cleanup(
        stage: string,
        work: () => unknown | Promise<unknown>,
        timeoutMs = 5000,
      ) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(work),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error("cleanup deadline")), timeoutMs);
            }),
          ]);
        } catch (error) {
          cleanupErrors.push({
            stage,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      try {
        await cleanup("Home", disposeHome);
        for (const [index, manager] of managers.entries())
          await cleanup(`manager-${index}`, () => manager.dispose());
        for (const [index, stream] of subscriptions.entries())
          await cleanup(`SSE-${index}`, async () => {
            stream.close();
            await stream.done.catch(() => {});
          });
        for (const [index, transport] of transports.entries())
          await cleanup(`transport-${index}`, async () => {
            transport.dispose();
            await transport.closed;
          });
        for (const [index, owners] of registries.entries())
          await cleanup(`owners-${index}`, () => owners.dispose());
        for (const socket of sockets)
          await cleanup(`tmux-${sockets.indexOf(socket)}`, () => stopTmux(socket));
        for (const [index, server] of servers.entries())
          await cleanup(
            `HTTP-${index}`,
            () =>
              new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                if ("closeAllConnections" in server) server.closeAllConnections();
              }),
          );
        report.fixtureDiagnostics = allocations.map((allocation) => allocation.diagnostics?.());
        await cleanup("SSH-processes", async () => {
          report.processCleanup = await tracker.dispose();
        });
        for (const [index, transport] of transports.entries())
          await cleanup(`forward-port-${index}`, () =>
            waitForPort(Number(new URL(transport.baseUrl).port), false),
          );
        // Outstanding or uncertain work retains all private evidence. Never remove its inputs.
        if (cleanupErrors.length === 0) {
          for (const [index, allocation] of allocations.reverse().entries())
            await cleanup(`private-files-${index}`, () => allocation.disposeFiles());
        }
        if (cleanupErrors.length === 0)
          await cleanup("root", () => rmSync(root, { recursive: true }));
      } finally {
        report.cleanupErrors = cleanupErrors;
        if (cleanupErrors.length) {
          report.outcome = "failed-cleanup";
          report.retainedPrivateRoot = root;
        }
        try {
          if (process.env.TMUX_IDE_OWNED_ACTIVITY_REPORT)
            writeFileSync(
              process.env.TMUX_IDE_OWNED_ACTIVITY_REPORT,
              JSON.stringify(report, null, 2) + "\n",
              { mode: 0o600 },
            );
        } finally {
          process.umask(previousUmask);
        }
      }
      if (cleanupErrors.length)
        teardownFailure = new AggregateError(
          cleanupErrors.map((error) => Error(`${error.stage}: ${error.message}`)),
          "Owned fixture cleanup incomplete; evidence retained",
        );
    }
    if (primaryFailure || teardownFailure)
      throw new AggregateError(
        [primaryFailure, teardownFailure].filter(Boolean),
        "Owned SSH qualification failed",
      );
  },
  120_000,
);
