/** Opt-in correctness qualification; no timing acceptance or performance claims. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createScratchFleet } from "../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts";
import { startDaemon } from "../apps/desktop-renderer/e2e/fixtures/daemon.ts";
import { openPaneStreamRuntimeClient } from "../packages/daemon-client/src/pane-stream-client.ts";
import { createOpenTuiPaneStreamSocket } from "../packages/daemon/src/tui/mirror/open-tui-pane-stream-socket.ts";
import { defaultNodePtyAdapter } from "../packages/daemon/src/terminal/NodePtyAdapter.ts";
import { decodeNativeGridCapture } from "../packages/daemon/src/terminal/mirror/native-grid-capture.ts";
import { projectNativeGridRow } from "../packages/daemon/src/terminal/mirror/native-grid-projection.ts";
import { createMacProcessIdentity } from "./lib/owned-ssh-fixture.mjs";
import { subscribeTmuxServerInteractions } from "../packages/daemon-client/src/tmux-server-interaction-events.ts";
import { TmuxServersResourceSchemaZ } from "../packages/contracts/src/tmux-server-scope.ts";
import { CoherenceDeliveryClient } from "./lib/coherence-delivery-client.ts";
import type { TerminalReplicaRow } from "../packages/contracts/src/index.ts";

import { PANE_STREAM_PROTOCOL_VERSION } from "../packages/contracts/src/pane-stream.ts";

const output = resolve(process.argv[2] ?? ".tasks/canonical-coherence");
mkdirSync(output, { mode: 0o700 }); // Existing evidence must never be overwritten.
const native = realpathSync(process.env.TMUX_IDE_C4_TMUX_BINARY ?? "");
// This process is a disposable qualification runner. Never inherit live session authority.
for (const key of Object.keys(process.env)) {
  if (key === "TMUX" || key.startsWith("TMUX_") || key === "NODE_OPTIONS" || key === "NODE_PATH")
    delete process.env[key];
}
process.env.TMUX_IDE_NATIVE_OBSERVATION = "1";
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const nativeHash = sha(native);
const controlledTmux = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
assert.equal(controlledTmux, native, "PATH must resolve the exact pinned native artifact");
const records = 500;
const shapes = Array.from({ length: 20 }, (_, i) => [80 + i * 2, 25 + (i % 7)] as const);
const producer = join(output, "producer.cjs");
writeFileSync(
  producer,
  `process.stdin.setRawMode(true);let started=false;process.stdout.write('READY\\r\\n');process.stdin.on('data',()=>{if(started)return;started=true;process.stdout.write('\\x1b[?1049hALT\\x1b[?1049l');let i=0;const t=setInterval(()=>{process.stdout.write('REC_'+String(i++).padStart(4,'0')+'\\r\\n');if(i===500){clearInterval(t);process.stdout.write('\\x1b[38;5;196mCOLOR\\x1b[0m 界é\\r\\nDONE_C4');}},2);});`,
);
const manifest = {
  source,
  native,
  nativeHash,
  records,
  shapes,
  clients: [2, 4, 8],
  node: process.version,
  producerHash: sha(producer),
  driverHash: sha(import.meta.filename),
};
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(
  label: string,
  test: () => boolean | Promise<boolean>,
  errors: Error[],
  ms = 15000,
) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (errors.length) throw errors[0];
    if (await test()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
}
const text = (rows: readonly TerminalReplicaRow[]) =>
  rows
    .map((r) =>
      r.cells
        .map((c) => (c.width === 0 ? "" : c.grapheme || " "))
        .join("")
        .trimEnd(),
    )
    .join("\n");
const paint = (rows: readonly TerminalReplicaRow[]) =>
  rows.map((r) =>
    r.cells.map((c) => [c.grapheme, c.width, c.foreground, c.background, c.attributes]),
  );
const results: unknown[] = [];
let disposeIdentity: (() => Promise<void>) | undefined;
const identity = await createMacProcessIdentity({
  parent: output,
  onAllocated: (allocation: { disposeFiles: () => Promise<void> }) => {
    disposeIdentity = allocation.disposeFiles;
  },
});
let qualificationFailure: unknown;
try {
  for (const count of [2, 4, 8]) {
    let fleet: Awaited<ReturnType<typeof createScratchFleet>> | undefined;
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let pty: ReturnType<typeof defaultNodePtyAdapter.spawnSync> | undefined;
    const clients: Awaited<ReturnType<typeof openPaneStreamRuntimeClient>>[] = [];
    const decoders: CoherenceDeliveryClient[] = [];
    const errors: Error[] = [];
    const cleanup: Record<string, string> = {};
    let serverPid = 0;
    let serverStart: string | null = null;
    let socketIdentity: { dev: number; ino: number } | undefined;
    let ptyExited = false;
    let observation: ReturnType<typeof subscribeTmuxServerInteractions> | undefined;
    let observationClosed = false;
    let receiptCount = 0;
    let facts: unknown = null;
    const tmux = (...args: string[]) =>
      execFileSync(native, ["-S", fleet!.socketPath, ...args], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 16 << 20,
        env: { ...process.env, TMUX: "" },
      });
    try {
      fleet = await createScratchFleet({
        sessions: 1,
        windowsPerSession: 1,
        slug: `coherence-${count}`,
        initialPaneCommand: { executable: process.execPath, args: [producer] },
      });
      serverPid = Number(tmux("display-message", "-p", "#{pid}").trim());
      serverStart = await identity.identify(serverPid);
      const socket = lstatSync(fleet.socketPath);
      assert(socket.isSocket() && socket.uid === process.getuid!());
      socketIdentity = { dev: socket.dev, ino: socket.ino };
      assert(serverPid > 0 && serverStart);
      const session = fleet.sessionNames[0]!;
      const runtimePane = fleet.initialPanes[0]!.paneId;
      tmux("set-option", "-g", "history-limit", "10000");
      tmux("set-option", "-t", session, "status", "off");
      tmux("set-window-option", "-t", session, "window-size", "latest");
      daemon = await startDaemon(fleet);
      const workspace = await daemon.promote(session);
      const response = await fetch(`${daemon.baseUrl}/api/v1/tmux-servers`, {
        headers: { Authorization: `Bearer ${daemon.record.authToken}` },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      assert(response.ok, "Server inventory unavailable");
      const servers = TmuxServersResourceSchemaZ.parse(await response.json()).servers;
      assert.equal(servers.length, 1, "Scratch fixture must contain exactly one server");
      const server = servers[0]!;
      assert(server.state === "online");
      observation = subscribeTmuxServerInteractions({
        baseUrl: daemon.baseUrl,
        ownerToken: daemon.record.authToken,
        server: { serverId: server.serverId, generation: server.generation },
        onBatch: (batch) => {
          receiptCount += batch.receipts.length;
        },
      });
      void observation.done.catch((error) => {
        if (!observationClosed) errors.push(error);
      });
      await observation.ready;
      await waitFor(
        "native journal ready",
        () => observation!.getObservationStatus()?.method === "native-journal",
        errors,
      );
      const initialObservation = observation.getObservationStatus();
      const pane = tmux("show-options", "-p", "-v", "-t", runtimePane, "@tmux_ide_pane_id").trim();
      assert(pane);
      for (let i = 0; i < count; i++) {
        let client: Awaited<ReturnType<typeof openPaneStreamRuntimeClient>> | undefined;
        const earlyAcks: Parameters<CoherenceDeliveryClient["sendAck"]>[0][] = [];
        const decoder = new CoherenceDeliveryClient(workspace, pane, (ack) =>
          client ? client.ack(ack) : earlyAcks.push(ack),
        );
        client = await openPaneStreamRuntimeClient({
          baseUrl: daemon.baseUrl,
          ownerToken: daemon.record.authToken,
          daemonInstanceId: daemon.record.instanceId,
          origin: "tmux-ide://opentui",
          hostClientId: `coherence:${count}:${i}`,
          requestId: randomUUID(),
          requestInitialInputAuthority: false,
          stream: {
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
            workspaceName: workspace,
            panes: [pane],
            viewerMode: "read-only",
            terminalDelivery: {
              protocolVersions: [1],
              encodings: ["semantic-v1"],
              richPlacements: false,
            },
          },
          createSocket: createOpenTuiPaneStreamSocket,
          onNegotiated: (_pane, result) => decoder.negotiate(result),
          onTerminalDelivery: (_pane, message) => {
            try {
              decoder.receive(message);
            } catch (e) {
              errors.push(e as Error);
            }
          },
          onFault: (e) => errors.push(e),
        });
        clients.push(client);
        decoders.push(decoder);
        earlyAcks.forEach((ack) => client!.ack(ack));
      }
      await waitFor("initial decoded clients", () => decoders.every((d) => d.commits > 0), errors);
      pty = defaultNodePtyAdapter.spawnSync(
        {
          shell: native,
          args: ["-S", fleet.socketPath, "attach", "-t", `=${session}`],
          cwd: fleet.projectDir,
          cols: 100,
          rows: 30,
          env: { ...process.env, TMUX: "", TERM: "xterm-256color" },
          name: "xterm-256color",
          encoding: null,
        },
        {
          onData: () => undefined,
          onExit: () => {
            ptyExited = true;
          },
        },
      );
      const slowBaseline = decoders.at(-1)!.commits;
      decoders.at(-1)!.hold();
      tmux("send-keys", "-t", runtimePane, "g");
      for (const [cols, rows] of shapes) {
        pty.resize(cols, rows);
        await sleep(5);
      }
      await waitFor(
        "healthy clients reach final output",
        () =>
          decoders
            .slice(0, -1)
            .every((d) => text(d.state!.canonicalSnapshot!.grid).includes("DONE_C4")),
        errors,
      );
      const slowCommits = decoders.at(-1)!.commits;
      assert(decoders.at(-1)!.acknowledgementHeld, "Slow client never held an ACK");
      assert.equal(slowCommits, slowBaseline + 1, "Slow client advanced beyond its held ACK");
      assert(
        !text(decoders.at(-1)!.state!.canonicalSnapshot!.grid).includes("DONE_C4"),
        "Workload failed to exercise a client stalled before final output",
      );
      decoders.at(-1)!.release();
      await waitFor(
        "all clients converge",
        () =>
          decoders.every((d) => text(d.state!.canonicalSnapshot!.grid).includes("DONE_C4")) &&
          new Set(decoders.map((d) => d.state!.appliedHash)).size === 1,
        errors,
      );
      const raw = tmux("capture-pane", "-p", "-R", "-S", "-", "-t", runtimePane);
      const oracle = decodeNativeGridCapture(raw);
      assert(oracle && oracle.version === 2, "Invalid native oracle");
      const [cols, rows] = shapes.at(-1)!;
      assert.equal(oracle.cols, cols);
      assert.equal(oracle.rows, rows);
      const oracleGrid = oracle.grid
        .slice(oracle.history)
        .map((row) => projectNativeGridRow(row, oracle.cols)!);
      for (const decoder of decoders) {
        const snapshot = decoder.state!.canonicalSnapshot!;
        assert.equal(snapshot.cols, cols);
        assert.equal(snapshot.rows, rows);
        assert.deepEqual(paint(snapshot.grid), paint(oracleGrid));
        const ids = text([...snapshot.history, ...snapshot.grid]).match(/REC_\d{4}/g);
        assert.deepEqual(
          ids,
          Array.from({ length: records }, (_, i) => `REC_${String(i).padStart(4, "0")}`),
        );
        assert.deepEqual([snapshot.cursor.x, snapshot.cursor.y], oracle.cursor);
        assert.equal(snapshot.modes.alternateScreen, false);
      }
      facts = {
        count,
        initialObservation,
        finalObservation: observation.getObservationStatus(),
        receiptCount,
        slowCommitsBeforeRelease: slowCommits,
        hashes: decoders.map((d) => d.state!.appliedHash),
        commits: decoders.map((d) => d.commits),
        nativeDigest: createHash("sha256").update(raw).digest("hex"),
        cols,
        rows,
        records,
      };
    } catch (error) {
      errors.push(error as Error);
    } finally {
      for (const client of clients) {
        try {
          client.close();
        } catch (error) {
          errors.push(error as Error);
        }
      }
      if (observation) {
        observationClosed = true;
        observation.close();
        try {
          await observation.done;
          cleanup.observation = "confirmed";
        } catch (error) {
          errors.push(error as Error);
        }
      }
      if (pty) {
        try {
          if (!ptyExited) pty.kill();
          await waitFor("PTY exit", () => ptyExited, [], 5000);
          assert.equal(await identity.identify(pty.pid), null, "PTY process remains alive");
          cleanup.pty = "confirmed";
        } catch (e) {
          errors.push(e as Error);
        }
      }
      if (daemon) {
        try {
          await daemon.stop();
          cleanup.daemon = "confirmed";
        } catch (e) {
          errors.push(e as Error);
        }
      }
      if (fleet) {
        try {
          assert.equal(
            await identity.identify(serverPid),
            serverStart,
            "Private server identity changed before cleanup",
          );
          const socket = lstatSync(fleet.socketPath);
          assert(socket.isSocket() && socket.uid === process.getuid!());
          assert.deepEqual(
            { dev: socket.dev, ino: socket.ino },
            socketIdentity,
            "Private socket identity changed before cleanup",
          );
          assert.equal(Number(tmux("display-message", "-p", "#{pid}").trim()), serverPid);
          tmux("kill-server");
          await waitFor(
            "server exit",
            async () => (await identity.identify(serverPid)) === null,
            [],
            5000,
          );
          cleanup.server = "confirmed";
          rmSync(fleet.root, { recursive: true, force: true });
        } catch (e) {
          errors.push(e as Error);
          cleanup.server = "failed";
        }
      }
      try {
        assert.equal(sha(native), nativeHash);
      } catch (error) {
        errors.push(error as Error);
      }
      const report = {
        count,
        facts,
        cleanup,
        failures: errors.map((e) => ({ name: e.name, message: e.message })),
      };
      results.push(report);
      writeFileSync(join(output, `clients-${count}.json`), JSON.stringify(report, null, 2));
    }
    if (errors.length)
      throw new AggregateError(errors, `Coherence ${count} failed; retained evidence`);
  }
} catch (error) {
  qualificationFailure = error;
} finally {
  try {
    await disposeIdentity?.();
  } catch (error) {
    qualificationFailure = qualificationFailure
      ? new AggregateError(
          [qualificationFailure, error],
          "Qualification and identity cleanup failed",
        )
      : error;
  }
  writeFileSync(
    join(output, "report.json"),
    JSON.stringify(
      {
        completed: !qualificationFailure,
        manifest,
        results,
        failure: qualificationFailure instanceof Error ? qualificationFailure.message : null,
      },
      null,
      2,
    ),
  );
}
if (qualificationFailure) throw qualificationFailure;
writeFileSync(join(output, "complete.json"), JSON.stringify({ manifest, results }, null, 2));
