/** Optional canonical-daemon phase for the existing owned SSH replacement qualification. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  AutomationPanesResponseSchemaZ,
  AutomationExecuteResponseSchemaZ,
  AutomationStatusResponseSchemaZ,
  DaemonEventServerFrameSchemaZ,
  type InteractionJournalEntry,
  type CanonicalDaemonInfo,
  type DaemonEventServerFrame,
} from "../../packages/contracts/src/index.ts";
import { subscribeTmuxServerInteractions } from "../../packages/daemon-client/src/tmux-server-interaction-events.ts";
import { createApplicationDaemonAuthority } from "../../packages/daemon/src/tui/mirror/runtime/application-daemon-authority-owner.ts";
import { createApplicationMachineAuthorityManager } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-authority.ts";
import { createApplicationMachineCatalog } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-catalog.ts";
import { createApplicationMachineAgents } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-agents.ts";
import { applicationPaneActivitySources } from "../../packages/daemon/src/tui/mirror/runtime/application-pane-activity-owner.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
} from "../../packages/daemon/src/lib/ssh-daemon-transport.ts";
import { createTmuxServerProbe } from "../../packages/daemon/src/lib/tmux-server-registration.ts";

export async function qualifyCanonicalSshAttribution(options: {
  local: CanonicalDaemonInfo;
  remote: CanonicalDaemonInfo;
  alias: string;
  connect: typeof openSshDaemonTransport;
  privateParent: string;
  executable: string;
  session: string;
  signal: AbortSignal;
  identify(pid: number): Promise<string | null>;
  stampRemoteDefault(state: string): Promise<void>;
  facts: Record<string, unknown>;
}) {
  const facts = options.facts;
  facts.kind = "canonical-daemon-real-ssh-fleet-and-global-clock";
  const execute = promisify(execFile);
  const root = mkdtempSync(join(options.privateParent, "n-"));
  const socket = join(root, "s");
  const run = async (args: string[]) =>
    (
      await execute(options.executable, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, TMUX: "" },
      })
    ).stdout.trim();
  const wait = async (predicate: () => boolean, label: string, ms = 15000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      options.signal.throwIfAborted();
      if (Date.now() >= end) throw Error(label);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const transports: Awaited<ReturnType<typeof openSshDaemonTransport>>[] = [];
  const manager = createApplicationMachineAuthorityManager({
    createOwner: () =>
      createApplicationDaemonAuthority({
        readLocal: () => options.local,
        isLocalAlive: async () => true,
        observeLocal: async () => () => {},
        verify: probeSshDaemonIdentity,
        connect: async (input) => {
          const transport = await options.connect(input);
          transports.push(transport);
          return transport;
        },
      }),
  });
  const catalog = createApplicationMachineCatalog({ manager });
  const agents = createApplicationMachineAgents({ manager, catalog });
  let events: WebSocket | undefined;
  let stream: ReturnType<typeof subscribeTmuxServerInteractions> | undefined;
  let registration: { serverId: string; generation: string } | undefined;
  let tmuxAttempted = false;
  let observation:
    | NonNullable<Awaited<ReturnType<ReturnType<typeof createTmuxServerProbe>>>>
    | undefined;
  let witness: string | null = null;
  let remoteBase = "";
  let primary: unknown;
  const cleanupErrors: string[] = [];
  const json = async (path: string, body?: unknown, method?: string, cleanup = false) => {
    const response = await fetch(remoteBase + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${options.remote.authToken}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: cleanup
        ? AbortSignal.timeout(4000)
        : AbortSignal.any([options.signal, AbortSignal.timeout(10000)]),
    });
    const value = await response.json();
    assert(response.ok, JSON.stringify(value));
    return value;
  };
  try {
    const id = randomUUID();
    manager.initialize([
      { id, label: "Owned canonical remote", sshTarget: options.alias, enabled: true },
    ]);
    assert(await manager.getMachine(id)!.ready);
    assert.equal(manager.snapshot().selectedMachineId, "local");
    remoteBase = manager.getMachine(id)!.endpoint().localBaseUrl!;
    catalog.start();
    agents.start();
    await wait(() => {
      const groups = agents.getSnapshot();
      return ["local", id].every((machine) =>
        groups.some(
          (group) =>
            group.machineId === machine &&
            group.available &&
            group.agents.some(
              (agent) => agent.sessionName === options.session && agent.interactionEndpoint,
            ),
        ),
      );
    }, "Canonical Home agent discovery unavailable");
    const rows = agents
      .getSnapshot()
      .flatMap((group) => group.agents)
      .filter((agent) => agent.sessionName === options.session);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.interactionEndpoint!.semanticPaneId)).size, 1);
    assert.equal(new Set(rows.map((row) => row.interactionEndpoint!.environmentId)).size, 2);
    const groups = catalog.getSnapshot().groups.map((group) => ({
      ...group,
      agents: agents.getSnapshot().find((agents) => agents.machineId === group.id)?.agents ?? [],
    }));
    const sources = applicationPaneActivitySources(groups, "local", [], (machine) =>
      manager.getMachine(machine)?.read(),
    );
    assert.equal(sources.length, 2);
    facts.home = {
      selectedMachine: manager.snapshot().selectedMachineId,
      endpoints: rows.map((row) => row.interactionEndpoint),
      sources: sources.map((source) => ({
        environmentId: source.environmentId,
        server: source.server,
      })),
    };
    const defaultEndpoint = rows.find((row) => row.machineId === id)!.interactionEndpoint!;
    assert.equal(defaultEndpoint.serverScope.generation, options.remote.instanceId);

    const frames: DaemonEventServerFrame[] = [];
    let protocolError: unknown;
    events = new WebSocket(remoteBase.replace(/^http/, "ws") + "/ws/events", {
      headers: { Authorization: `Bearer ${options.remote.authToken}` },
    });
    events.on("error", (error) => {
      protocolError = error;
    });
    events.on("message", (bytes) => {
      try {
        if (frames.length >= 512) throw Error("Bounded frame journal overflow");
        frames.push(DaemonEventServerFrameSchemaZ.parse(JSON.parse(bytes.toString())));
      } catch (error) {
        protocolError = error;
      }
    });
    await wait(
      () => frames.some((frame) => frame.type === "hello") || !!protocolError,
      "Legacy hello",
    );
    if (protocolError) throw protocolError;
    const hello = frames.find((frame) => frame.type === "hello")!;
    assert.equal(hello.type, "hello");
    assert.equal(hello.daemon.instanceId, options.remote.instanceId);
    const interests = [
      { resource: "fleet-catalog", workspaceName: null },
      { resource: "application-shell", workspaceName: options.session },
    ];
    events.send(
      JSON.stringify({
        type: "subscribe",
        sessions: [options.session],
        interests,
        legacyEvents: true,
        interestRevision: 1,
      }),
    );
    await wait(
      () =>
        frames.some(
          (frame) => frame.type === "resource.interests-ack" && frame.interestRevision === 1,
        ),
      "Legacy observer barrier",
    );
    const changed = () => frames.filter((frame) => frame.type === "resource.changed");
    let before = changed().length;
    await options.stampRemoteDefault(`blocked:${Date.now()}`);
    await wait(() => changed().length > before, "Default mutation before nondefault events");
    const startCursor = Math.max(
      0,
      ...frames.flatMap((frame) => ("sequence" in frame ? [frame.sequence] : [])),
    );

    tmuxAttempted = true;
    await run(["new-session", "-d", "-s", options.session, "cat"]);
    observation =
      (await createTmuxServerProbe(options.executable)({ kind: "path", path: socket })) ??
      undefined;
    assert(observation?.nativeServerIdentity);
    const witnessDeadline = Date.now() + 1500;
    while (!witness && Date.now() < witnessDeadline) {
      try {
        witness = await options.identify(Number(observation.nativeServerIdentity.pid));
      } catch {
        /* No mutation is authorized by an unadmitted witness. */
      }
      if (!witness) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(witness && observation.valid());
    const confirmed = await createTmuxServerProbe(options.executable)({
      kind: "path",
      path: socket,
    });
    assert.equal(confirmed?.fingerprint, observation.fingerprint);
    await run([
      "set-option",
      "-p",
      "-t",
      options.session + ":0.0",
      "@tmux_ide_pane_id",
      defaultEndpoint.semanticPaneId,
    ]);
    await run([
      "set-option",
      "-p",
      "-t",
      options.session + ":0.0",
      "@agent_state",
      `idle:${Date.now()}`,
    ]);
    registration = await json("/api/v1/tmux-servers", {
      label: "Owned attribution secondary",
      selector: { kind: "path", path: socket },
    });
    assert(registration?.generation);
    const discovered = AutomationPanesResponseSchemaZ.parse(await json("/api/v1/automation/panes"));
    const target = discovered.panes.find(
      (pane) => pane.endpoint.serverScope.serverId === registration!.serverId,
    )?.endpoint;
    assert(target);
    assert.equal(target.semanticPaneId, defaultEndpoint.semanticPaneId);
    await run(["send-keys", "-t", options.session + ":0.0", "-l", "owned-secondary-marker"]);
    await run(["send-keys", "-t", options.session + ":0.0", "Enter"]);
    const received: InteractionJournalEntry[] = [],
      operationIds: string[] = [];
    stream = subscribeTmuxServerInteractions({
      baseUrl: remoteBase,
      ownerToken: options.remote.authToken!,
      server: target.serverScope,
      onBatch: (batch) => {
        if (received.length + batch.receipts.length > 128)
          throw Error("Bounded scoped journal overflow");
        received.push(...batch.receipts);
      },
    });
    await stream.ready;
    for (let count = 0; count < 3; count++) {
      const intent = { kind: "read", target, source: null };
      const { handle } = await json("/api/v1/automation/reserve", { version: 1, intent });
      operationIds.push(handle.operationId);
      const completed = AutomationExecuteResponseSchemaZ.parse(
        await json("/api/v1/automation/execute", { version: 1, intent, handle }),
      );
      assert.deepEqual(completed.handle, handle);
      assert.equal(completed.result.kind, "read");
      assert.equal(completed.read?.availability, "available");
      assert(
        completed.read?.availability === "available" &&
          completed.read.text.includes("owned-secondary-marker"),
      );
      assert(Buffer.byteLength(completed.read.text, "utf8") <= 16384);
      const status = AutomationStatusResponseSchemaZ.parse(
        await json(`/api/v1/automation/operations/${handle.generation}/${handle.operationId}`),
      );
      assert.equal(status.status, "completed");
      assert(!JSON.stringify(status).includes("owned-secondary-marker"));
    }
    await wait(
      () =>
        operationIds.every((id) =>
          ["accepted", "observed"].every((phase) =>
            received.some(
              (receipt) =>
                receipt.type === "interaction.receipt" &&
                receipt.operationId === id &&
                receipt.phase === phase,
            ),
          ),
        ),
      "Each scoped operation admission and completion receipt",
    );
    const matched = received.filter(
      (receipt) =>
        receipt.type === "interaction.receipt" && operationIds.includes(receipt.operationId),
    );
    for (const receipt of matched) {
      assert.equal(receipt.type, "interaction.receipt");
      assert(receipt.evidence);
      assert.deepEqual(receipt.evidence.endpoints.destination, target);
      assert.equal(receipt.operationKind, "workspace.pane.read");
      if (receipt.phase === "observed")
        assert(receipt.proof?.operationKind === "workspace.pane.read");
    }
    before = changed().length;
    await options.stampRemoteDefault(`done:${Date.now()}`);
    await wait(() => changed().length > before, "Default mutation after nondefault events");
    // A later acknowledged barrier orders the inspection after both real update phases.
    events.send(
      JSON.stringify({
        type: "subscribe",
        sessions: [options.session],
        interests,
        legacyEvents: true,
        interestRevision: 2,
      }),
    );
    await wait(
      () =>
        frames.some(
          (frame) => frame.type === "resource.interests-ack" && frame.interestRevision === 2,
        ),
      "Final default barrier",
    );
    if (protocolError) throw protocolError;
    assert.equal(frames.filter((frame) => frame.type === "hello").length, 1);
    assert(!frames.some((frame) => frame.type === "snapshot-required"));
    const sequences = frames.flatMap((frame) =>
      frame.type === "resource.changed" || frame.type === "resource.observed"
        ? [frame.sequence]
        : [],
    );
    assert(sequences.some((value) => value > startCursor));
    assert(sequences.every((value, index) => index === 0 || value > sequences[index - 1]!));
    assert(
      !frames.some(
        (frame) => frame.type === "interaction.receipt" && operationIds.includes(frame.operationId),
      ),
    );
    assert(
      !frames.some(
        (frame) =>
          frame.type === "interaction.receipt" &&
          frame.evidence?.endpoints.destination.serverScope.serverId ===
            target.serverScope.serverId,
      ),
    );
    assert.equal(new Set(received.map((receipt) => receipt.sequence)).size, received.length);
    facts.clock = {
      daemon: options.remote.instanceId,
      startCursor,
      sequences,
      scopedSequences: received.map((receipt) => receipt.sequence),
      scopedOperations: matched.map((receipt) =>
        receipt.type === "interaction.receipt"
          ? { operationId: receipt.operationId, phase: receipt.phase }
          : null,
      ),
      scopedEndpoint: target,
      operationIds,
      helloCount: 1,
      reset: false,
      foreignReceiptLeak: false,
    };
    facts.ok = true;
  } catch (error) {
    primary = error;
    facts.ok = false;
    facts.failure = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanup = async (name: string, action: () => unknown | Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(action),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("deadline")), 5000);
          }),
        ]);
      } catch (error) {
        cleanupErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await cleanup("scoped-stream", async () => {
      stream?.close();
      await stream?.done.catch(() => {});
    });
    await cleanup(
      "legacy-stream",
      () =>
        new Promise<void>((resolve) => {
          if (!events || events.readyState === WebSocket.CLOSED) return resolve();
          events.once("close", () => resolve());
          events.terminate();
        }),
    );
    await cleanup("agents", () => agents.dispose());
    await cleanup("catalog", () => catalog.dispose());
    if (registration)
      await cleanup("registration", () =>
        json(`/api/v1/tmux-servers/${registration!.serverId}`, undefined, "DELETE", true),
      );
    await cleanup("manager", () => manager.dispose());
    for (const transport of transports)
      await cleanup("transport", async () => {
        transport.dispose();
        await transport.closed;
      });
    if (tmuxAttempted && !observation)
      cleanupErrors.push("Private tmux creation outcome has no admitted witness");
    if (observation)
      await cleanup("private-tmux", async () => {
        const identity = observation!.nativeServerIdentity!;
        assert(
          witness &&
            (await options.identify(Number(identity.pid))) === witness &&
            observation!.valid(),
        );
        const current = await createTmuxServerProbe(options.executable)({
          kind: "path",
          path: socket,
        });
        assert.equal(current?.fingerprint, observation!.fingerprint);
        const guard = `#{&&:#{==:#{pid},${identity.pid}},#{==:#{start_time},${identity.startTime}}}`;
        assert.equal(
          await run(["if-shell", "-F", guard, "kill-server", "display-message -p refused"]),
          "",
        );
        const end = Date.now() + 3000;
        while ((await options.identify(Number(identity.pid))) !== null) {
          if (Date.now() > end) throw Error("Private tmux exit unproven");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      });
    if (!cleanupErrors.length) rmSync(root, { recursive: true });
    else facts.retainedPrivateRoot = root;
    facts.cleanupErrors = cleanupErrors;
  }
  if (primary || cleanupErrors.length)
    throw new AggregateError(
      [primary, ...cleanupErrors].filter(Boolean),
      "Canonical SSH attribution qualification failed",
    );
}
