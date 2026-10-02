/** Optional physical-recovery observer: real retained compiled TUI PTYs, not Home models. */
import assert from "node:assert/strict";
import { createSparkTuiLogCapture } from "./spark-private-diagnostics.ts";
import { admitSparkQualifiedTui } from "./spark-qualified-tui.ts";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSparkCanonicalConfig } from "../qualify-spark-canonical.ts";
import { ownedProcesses } from "./owned-ssh-fixture.mjs";
import {
  resolveDevelopmentInstance,
  validateDevelopmentDirectory,
} from "../../packages/daemon/src/lib/development-instance.ts";
import {
  developmentSshAuthority,
  developmentSshHandshake,
  type DevelopmentSshLease,
} from "../../packages/daemon/src/lib/development-ssh.ts";
import { readDevelopmentBuild } from "../../packages/daemon/src/lib/development-build.ts";
import { withDevelopmentLock } from "../../packages/daemon/src/lib/development-lock.ts";
import {
  readPrivateDevelopmentRecord,
  writeDevelopmentRecord,
  developmentProcessIdentity,
} from "../../packages/daemon/src/lib/development-state.ts";
import { readTmux, socketIdentity } from "../../packages/daemon/src/lib/development-lifecycle.ts";
import { revalidateUnixSocketIdentity } from "../../packages/daemon/src/lib/unix-socket-authority.ts";

import {
  createRetainedTuiDiagnostics,
  RetainedTuiDeadline,
} from "./spark-retained-tui-diagnostics.ts";

type TimingPhase = "baseline" | "forward-loss" | "reconnect" | "replacement" | "cleanup";
type TimingStep =
  | "hook"
  | "forward-lookup"
  | "forward-exit"
  | "remote-output"
  | "remote-input"
  | "local-input"
  | "local-health";

/** Diagnostic elapsed times only; never relax a deadline or export error text. */
export function createSparkTuiTimings(now = () => performance.now()) {
  const records: {
    phase: TimingPhase;
    step: TimingStep;
    elapsedMs: number | null;
    outcome: "running" | "passed" | "failed";
  }[] = [];
  return {
    async run<T>(phase: TimingPhase, step: TimingStep, work: () => Promise<T>): Promise<T> {
      assert(records.length < 64, "Retained TUI timing inventory exceeded");
      const record: (typeof records)[number] = { phase, step, elapsedMs: null, outcome: "running" };
      records.push(record);
      const started = now();
      try {
        const result = await work();
        record.outcome = "passed";
        return result;
      } catch (error) {
        record.outcome = "failed";
        throw error;
      } finally {
        record.elapsedMs = Math.max(0, Math.round(now() - started));
      }
    },
    snapshot: () => records.map((record) => ({ ...record })),
  };
}

/** A sole local session may open directly, before a persistent Home frame exists. */
export function sparkTuiAdmission(frame: string): "home" | "terminal" | null {
  if (!/(?:^|[^A-Za-z0-9_.-])attribution-collision(?:$|[^A-Za-z0-9_.-])/u.test(frame)) return null;
  if (frame.includes("Your agents, across your machines")) return "home";
  return /\bF2\s+Terminals\b/u.test(frame) && !frame.includes("PASSIVE PREVIEW")
    ? "terminal"
    : null;
}

/** Fixed qualification viewport sidebar; never select a same-named session in another group. */
export function sparkTuiMachineSessionRow(frame: string, machine: string): number | null {
  const lines = frame.split("\n").map((line) => line.slice(0, 28).trim());
  const headings = lines.flatMap((line, index) => (line === `▾ ${machine}` ? [index] : []));
  if (headings.length !== 1) return null;
  const start = headings[0]! + 1;
  const rows: number[] = [];
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^[▾▸] /u.test(line) || /^F[0-9] /u.test(line)) break;
    if (/^attribution-collision [1-9][0-9]*p$/u.test(line)) rows.push(index + 1);
  }
  return rows.length === 1 ? rows[0]! : null;
}
export function sparkTuiMachineAdmitted(frame: string, machine: string): boolean {
  const header = frame.split("\n")[0] ?? "";
  return sparkTuiAdmission(frame) === "terminal" && header.includes(` ${machine} · `);
}

/** Drive only product keyboard/mouse routes; Home deliberately has no Machines sidebar. */
export async function selectSparkTuiMachine(options: {
  machine: string;
  frame(): string;
  write(input: string): void;
  wait(predicate: () => boolean): Promise<void>;
  checkpoint(value: "home-frame" | "machine-selection" | "terminal-frame"): void;
}) {
  options.checkpoint("home-frame");
  await options.wait(
    () =>
      sparkTuiAdmission(options.frame()) === "home" ||
      sparkTuiMachineSessionRow(options.frame(), options.machine) !== null,
  );
  // OpenTUI's testdrive KeyCodes.F2 uses the SS3 OQ sequence.
  if (sparkTuiAdmission(options.frame()) === "home") options.write("\x1bOQ");
  options.checkpoint("machine-selection");
  let row: number | null = null;
  await options.wait(
    () => (row = sparkTuiMachineSessionRow(options.frame(), options.machine)) !== null,
  );
  options.write(`\x1b[<0;10;${row}M\x1b[<0;10;${row}m`);
  options.checkpoint("terminal-frame");
  await options.wait(() => sparkTuiMachineAdmitted(options.frame(), options.machine));
}

const execute = promisify(execFile);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Timed-out observer hooks must settle before any successful cleanup receipt. */
export function createRetainedTuiWorkLifetime(external: AbortSignal) {
  const controller = new AbortController();
  const signal = AbortSignal.any([external, controller.signal]);
  const flights = new Set<Promise<void>>();
  return {
    signal,
    abort: () => controller.abort(),
    track: (work: () => Promise<void>) => {
      signal.throwIfAborted();
      const pending = work();
      flights.add(pending);
      void pending.then(
        () => flights.delete(pending),
        () => flights.delete(pending),
      );
      return pending;
    },
    async settle(timeoutMs = 5000) {
      assert(signal.aborted, "Close must stop new observer work before settlement");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...flights]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Retained TUI work retirement unproven")),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export type SparkTuiStage = "baseline" | "reconnected" | "replaced";
export function sparkTuiInput(token: string) {
  assert(/^[a-f0-9]{32}$/u.test(token));
  const marker = `TUI_INPUT_${token}`;
  // Entire output is octal-encoded, so seeing the typed shell line cannot pass.
  const encoded = [...marker]
    .map((char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`)
    .join("");
  return { marker, command: `printf '${encoded}\\n'\r` };
}

export function assessSparkRetainedTuiReport(report: {
  baseline: boolean;
  forwardLoss: boolean;
  reconnect: boolean;
  replacement: boolean;
  localSibling: boolean;
  cleanup: boolean;
  frames: Record<string, unknown>[];
  forwardProof: { oldPid: number; newPid: number; oldExited: boolean } | null;
  replacementProof: { oldDaemon: string; newDaemon: string; oldForwardExited: boolean } | null;
  cleanupReceipt: { closed: boolean; roots: number } | null;
}) {
  try {
    assert(
      report.baseline &&
        report.forwardLoss &&
        report.reconnect &&
        report.replacement &&
        report.localSibling &&
        report.cleanup,
    );
    assert(
      report.forwardProof?.oldExited && report.forwardProof.oldPid !== report.forwardProof.newPid,
    );
    assert(
      report.replacementProof?.oldForwardExited &&
        report.replacementProof.oldDaemon !== report.replacementProof.newDaemon,
    );
    assert(report.cleanupReceipt?.closed && report.cleanupReceipt.roots === 2);
    assert.equal(
      new Set(report.frames.map((frame) => frame.inputMarker)).size,
      report.frames.length,
    );
    for (const side of ["local", "remote"]) {
      const frames = report.frames.filter((frame) => frame.side === side);
      const stages =
        side === "local"
          ? ["baseline", "remote-forward-offline", "reconnected", "replaced"]
          : ["baseline", "reconnected", "replaced"];
      assert.equal(frames.length, stages.length);
      assert.equal(new Set(frames.map((frame) => frame.pid)).size, 1);
      assert.equal(new Set(frames.map((frame) => frame.witness)).size, 1);
      for (const stage of stages) {
        const entries = frames.filter((frame) => frame.stage === stage);
        assert.equal(entries.length, 1);
        const frame = entries[0]!;
        assert(
          Number.isSafeInteger(frame.pid) &&
            Number(frame.pid) > 0 &&
            typeof frame.witness === "string" &&
            frame.witness.length > 0,
        );
        assert(Number.isSafeInteger(frame.parsedChunks) && Number(frame.parsedChunks) > 0);
        assert(
          typeof frame.inputMarker === "string" &&
            /^TUI_INPUT_[a-f0-9]{32}$/u.test(frame.inputMarker),
        );
        assert(typeof frame.frame === "string" && frame.frame.includes(frame.inputMarker));
        assert.equal(frame.frameSha256, sha(frame.frame));
        if (side === "remote") {
          assert.equal(frame.outputMarker, `SPARK_TUI_${stage.toUpperCase()}`);
          assert(frame.frame.includes(String(frame.outputMarker)));
        }
      }
    }
    assert.notEqual(
      report.frames.find((frame) => frame.side === "local")!.pid,
      report.frames.find((frame) => frame.side === "remote")!.pid,
    );
    return { qualified: true, reason: null };
  } catch {
    return { qualified: false, reason: "retained-tui-proof-incomplete" };
  }
}

type Pty = {
  pid: number;
  write(text: string): void;
  kill(signal?: string): void;
  onData(callback: (text: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
};
type Vt = {
  write(text: string, done?: () => void): void;
  dispose(): void;
  buffer: {
    active: { getLine(index: number): { translateToString(trim: boolean): string } | undefined };
  };
};
type Client = {
  pty: Pty;
  vt: Vt;
  exited: boolean;
  witness: string;
  receipt: string;
  attempt: string;
  parsed: number;
  bytes: number;
  overflow: boolean;
  frame(): string;
};

export async function createSparkRetainedTuiObserver(options: {
  config: unknown;
  qualifiedTuiDescriptor?: string;
  parent: string;
  signal: AbortSignal;
  identify(pid: number): Promise<string | null>;
  remoteOutput(stage: SparkTuiStage): Promise<unknown>;
}) {
  assert(process.platform === "darwin" && process.getuid?.() !== 0);
  const config = validateSparkCanonicalConfig(options.config);
  const instance = resolveDevelopmentInstance(config.local.instance);
  const originalTmux = readTmux(instance);
  assert(originalTmux);
  const originalTmuxWitness = await options.identify(originalTmux.pid);
  assert(originalTmuxWitness);
  const localAuthority = await developmentSshAuthority(instance);
  assert.deepEqual(localAuthority.lease, config.local.expected);
  const ownerEnvironment: NodeJS.ProcessEnv = localAuthority.env;
  const build = readDevelopmentBuild(instance, {
    TMUX_IDE_DEVELOPMENT_BUILD: config.local.expected.generation,
    TMUX_IDE_DEVELOPMENT_BUILD_HASH: config.local.expected.manifestHash,
  });
  const qualifiedTui = options.qualifiedTuiDescriptor
    ? await admitSparkQualifiedTui({
        descriptor: options.qualifiedTuiDescriptor,
        repository: instance.worktree,
        build,
        signal: options.signal,
      })
    : undefined;
  const root = realpathSync(mkdtempSync(join(realpathSync(options.parent), "retained-tui-")));
  const route = join(root, "route.json");
  writeFileSync(route, JSON.stringify(config), { flag: "wx", mode: 0o600 });
  const bin = join(root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = `#!/bin/sh\nexec ${quote(build.tools.node)} --import ${quote(fileURLToPath(import.meta.resolve("tsx")))} ${quote(fileURLToPath(new URL("./spark-retained-tui-route.ts", import.meta.url)))} ${quote(route)} "$@"\n`;
  writeFileSync(join(bin, "ssh"), wrapper, { flag: "wx", mode: 0o700 });
  const report = {
    version: 1,
    scope: "physical-retained-tui-input-and-parsed-render",
    qualifiedTui: qualifiedTui
      ? { descriptor: qualifiedTui.descriptor, provenance: qualifiedTui.provenance }
      : null,
    root,
    baseline: false,
    forwardLoss: false,
    reconnect: false,
    replacement: false,
    localSibling: false,
    cleanup: false,
    forwardProof: null as { oldPid: number; newPid: number; oldExited: boolean } | null,
    replacementProof: null as {
      oldDaemon: string;
      newDaemon: string;
      oldForwardExited: boolean;
    } | null,
    cleanupReceipt: null as { closed: boolean; roots: number } | null,
    frames: [] as Record<string, unknown>[],
    boundary:
      "real PTY input through product transport to parsed TUI output; no optical or latency claim",
  };
  const diagnosticStreams: Array<NonNullable<ReturnType<typeof createSparkTuiLogCapture>>> = [];
  const diagnosticReceipts: unknown[] = [];
  const timing = createSparkTuiTimings();
  const clients = new Map<"remote" | "local", Client>();
  const diagnostics = createRetainedTuiDiagnostics(root, () =>
    [...clients].map(([side, client]) => ({
      side,
      frame: client.frame(),
      parsed: client.parsed,
      bytes: client.bytes,
      exited: client.exited,
    })),
  );
  const admissions = new Set<string>();
  const tracker = ownedProcesses({
    identify: options.identify,
    list: async () => {
      const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid="], {
        timeout: 3000,
        maxBuffer: 1024 * 1024,
      });
      return stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
          return { pid, ppid };
        });
    },
  });
  let closed = false;
  let closeFlight: Promise<void> | null = null;
  const lifetime = createRetainedTuiWorkLifetime(options.signal);
  const signal = lifetime.signal;
  const track = (work: () => Promise<void>) =>
    lifetime.track(async () => {
      try {
        await work();
      } catch (error) {
        diagnostics.fail(error);
        throw error;
      }
    });
  let oldForward: { pid: number; witness: string } | null = null;
  let remoteLease = config.remote.lease.expected;
  let reconnectedForward: { pid: number; witness: string } | null = null;
  const wait = async (predicate: () => boolean | Promise<boolean>, timeout = 30000) => {
    const end = Date.now() + timeout;
    for (;;) {
      signal.throwIfAborted();
      if (await predicate()) {
        signal.throwIfAborted();
        return;
      }
      if (Date.now() >= end) throw new RetainedTuiDeadline();
      await new Promise((done) => setTimeout(done, 25));
    }
  };
  const localHealth = async () => {
    assert.deepEqual(readTmux(instance), originalTmux);
    revalidateUnixSocketIdentity(socketIdentity(originalTmux));
    assert.equal(await options.identify(originalTmux.pid), originalTmuxWitness);
    assert.deepEqual((await developmentSshAuthority(instance)).lease, config.local.expected);
    await developmentSshHandshake(instance, config.local.expected);
  };
  async function open(side: "remote" | "local") {
    diagnostics.checkpoint("admission", side);
    signal.throwIfAborted();
    await localHealth();
    const req = createRequire(join(instance.worktree, "packages/daemon/package.json"));
    const ptyModule = req("node-pty") as {
      spawn(bin: string, args: string[], options: object): Pty;
    };
    const { Terminal } = req("@tmux-ide/xterm-headless") as {
      Terminal: new (options: object) => Vt;
    };
    const vt = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
    await withDevelopmentLock(instance, "lifecycle", async () => {
      // Read-only prepared-owner admission; never invoke up/rebuild or default discovery.
      await localHealth();
      const directory = join(instance.root, "apps");
      validateDevelopmentDirectory(directory, instance.store);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const cwd = join(instance.runtimeDir, "compiled-tui");
      validateDevelopmentDirectory(cwd, instance.runtimeDir);
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const attempt = randomUUID();
      const receipt = join(directory, `${attempt}.json`);
      const managerIncarnation = await developmentProcessIdentity(process.pid);
      assert(managerIncarnation && !closed);
      signal.throwIfAborted();
      const admission = {
        version: 1,
        attempt,
        managerPid: process.pid,
        managerIncarnation,
        pid: null as number | null,
        incarnation: null as string | null,
        generation: build.generation,
      };
      writeDevelopmentRecord(receipt, admission);
      admissions.add(receipt);
      qualifiedTui?.revalidate();
      const diagnostic = createSparkTuiLogCapture(
        join(instance.root, `tui-diagnostics-${randomUUID()}.pipe`),
        join(root, `${side}-diagnostics.jsonl`),
      );
      if (diagnostic) diagnosticStreams.push(diagnostic);
      else diagnosticReceipts.push({ side, captured: false });
      const pty = ptyModule.spawn(
        qualifiedTui?.binary ?? build.tui,
        ["app", ...(side === "remote" ? [`--ssh=${config.ssh.alias}`] : [])],
        {
          cwd,
          env: {
            ...ownerEnvironment,
            TERM: "xterm-256color",
            ...(diagnostic ? { TMUX_IDE_TUI_LOG: diagnostic.path } : {}),
            ...(side === "remote" ? { PATH: `${bin}:${ownerEnvironment.PATH ?? ""}` } : {}),
          },
          cols: 120,
          rows: 32,
        },
      );
      const handle = Object.assign(new EventEmitter(), {
        pid: pty.pid,
        exitCode: null as number | null,
        kill: (signal: string) => {
          pty.kill(signal);
          return true;
        },
      });
      tracker.retain(handle);
      const client: Client = {
        pty,
        vt,
        exited: false,
        witness: "",
        receipt,
        attempt,
        parsed: 0,
        bytes: 0,
        overflow: false,
        frame: () =>
          Array.from(
            { length: 32 },
            (_, n) => vt.buffer.active.getLine(n)?.translateToString(true) ?? "",
          ).join("\n"),
      };
      clients.set(side, client);
      pty.onData((text) => {
        client.bytes += Buffer.byteLength(text);
        if (client.bytes > 8 * 1024 * 1024) {
          client.overflow = true;
          return;
        }
        vt.write(text, () => {
          client.parsed++;
        });
      });
      pty.onExit(({ exitCode }) => {
        client.exited = true;
        handle.exitCode = exitCode;
        handle.emit("close", exitCode);
      });
      const witness = await options.identify(pty.pid);
      const incarnation = await developmentProcessIdentity(pty.pid);
      assert(witness && incarnation && !client.exited);
      client.witness = witness;
      writeDevelopmentRecord(receipt, { ...admission, pid: pty.pid, incarnation });
    });
    const client = clients.get(side)!;
    const machine = side === "local" ? "Local" : config.ssh.alias;
    await selectSparkTuiMachine({
      machine,
      frame: () => {
        assert(!client.exited && !client.overflow);
        return client.frame();
      },
      write: (input) => client.pty.write(input),
      wait,
      checkpoint: (checkpoint) => diagnostics.checkpoint(checkpoint, side),
    });
    await tracker.capture();
  }
  const sameClient = async (client: Client) => {
    assert(!client.exited && !client.overflow);
    assert.equal(
      await options.identify(client.pty.pid),
      client.witness,
      "TUI process was not retained",
    );
  };
  async function input(side: "remote" | "local", stage: string, output?: string) {
    const client = clients.get(side)!;
    diagnostics.checkpoint("identity", side);
    await sameClient(client);
    assert(sparkTuiMachineAdmitted(client.frame(), side === "local" ? "Local" : config.ssh.alias));
    diagnostics.checkpoint("output-frame", side);
    if (output) await wait(() => client.frame().includes(output));
    const frame = client.frame();
    assert(sparkTuiMachineAdmitted(frame, side === "local" ? "Local" : config.ssh.alias));
    const row = output ? frame.split("\n").findIndex((line) => line.includes(output)) + 1 : 16;
    client.pty.write(`\x1b[<0;55;${row}M\x1b[<0;55;${row}m`);
    // Selecting a read-only pane requests control asynchronously; await its actual UI acknowledgement.
    if (frame.includes("Read-only input")) {
      await wait(
        () =>
          !client.frame().includes("Read-only input") &&
          sparkTuiMachineAdmitted(client.frame(), side === "local" ? "Local" : config.ssh.alias),
      );
    }
    const probe = sparkTuiInput(randomUUID().replaceAll("-", ""));
    assert(!client.frame().includes(probe.marker));
    const parsedBefore = client.parsed;
    diagnostics.checkpoint("input-frame", side);
    client.pty.write(probe.command);
    await wait(() => client.parsed > parsedBefore && client.frame().includes(probe.marker));
    await sameClient(client);
    report.frames.push({
      side,
      stage,
      pid: client.pty.pid,
      witness: client.witness,
      inputMarker: probe.marker,
      outputMarker: output ?? null,
      parsedChunks: client.parsed - parsedBefore,
      frameSha256: sha(client.frame()),
      frame: client.frame(),
    });
  }
  async function remoteIo(stage: SparkTuiStage) {
    const phase: TimingPhase =
      stage === "baseline" ? "baseline" : stage === "reconnected" ? "reconnect" : "replacement";
    const expected = `SPARK_TUI_${stage.toUpperCase()}`;
    assert(!clients.get("remote")!.frame().includes(expected), "Output marker already rendered");
    diagnostics.checkpoint("output-action", "remote");
    assert.deepEqual(await timing.run(phase, "remote-output", () => options.remoteOutput(stage)), {
      emitted: expected,
    });
    await timing.run(phase, "remote-input", () => input("remote", stage, expected));
    await timing.run(phase, "local-input", () => input("local", stage));
    await timing.run(phase, "local-health", localHealth);
    report.localSibling = true;
  }
  async function forward() {
    diagnostics.checkpoint("forward-discovery", "remote");
    let found: { pid: number; witness: string } | null = null;
    await wait(async () => {
      await tracker.capture();
      const ancestry = tracker.snapshot().ancestry;
      const records = readdirSync(root).filter((name) => /^child-[a-f0-9-]{36}\.json$/u.test(name));
      assert(records.length <= 128, "Bounded route child inventory exceeded");
      for (const name of records) {
        const record = readPrivateDevelopmentRecord<{
          pid: number;
          wrapperPid: number;
          kind: string;
          daemonId: string;
          port: number;
        }>(join(root, name));
        if (
          record?.kind !== "forward" ||
          record.daemonId !== remoteLease.daemonId ||
          record.port !== remoteLease.port
        )
          continue;
        if (
          !ancestry.some(
            (entry: { pid: number; rootPid: number }) =>
              entry.pid === record.pid && entry.rootPid === clients.get("remote")!.pty.pid,
          )
        )
          continue;
        const witness = await options.identify(record.pid);
        if (witness) {
          assert(!found || found.pid === record.pid, "Multiple live TUI forwards");
          found = { pid: record.pid, witness };
        }
      }
      return found !== null;
    });
    return found!;
  }
  const hooks = {
    async baseline() {
      diagnostics.phase("baseline");
      diagnostics.checkpoint("baseline");
      assert(!closed && !report.baseline);
      await open("local");
      await open("remote");
      await remoteIo("baseline");
      await timing.run("baseline", "forward-lookup", forward);
      report.baseline = true;
    },
    async forwardLost() {
      diagnostics.phase("forward-loss");
      diagnostics.checkpoint("forward-loss");
      assert(report.baseline && !closed && !report.forwardLoss);
      writeFileSync(join(root, "hold.json"), JSON.stringify({ held: true }), {
        flag: "wx",
        mode: 0o600,
      });
      oldForward = await timing.run("forward-loss", "forward-lookup", forward);
      assert.equal(await options.identify(oldForward.pid), oldForward.witness);
      process.kill(oldForward.pid, "SIGTERM");
      await timing.run("forward-loss", "forward-exit", () =>
        wait(async () => (await options.identify(oldForward!.pid)) === null, 5000),
      );
      await timing.run("forward-loss", "local-input", () =>
        input("local", "remote-forward-offline"),
      );
      await timing.run("forward-loss", "local-health", localHealth);
      report.forwardLoss = true;
    },
    async forwarded() {
      diagnostics.phase("reconnect");
      diagnostics.checkpoint("reconnect");
      assert(report.forwardLoss && !closed);
      assert.deepEqual(readPrivateDevelopmentRecord(join(root, "hold.json")), { held: true });
      rmSync(join(root, "hold.json"));
      const next = await timing.run("reconnect", "forward-lookup", forward);
      assert.notEqual(next.pid, oldForward!.pid);
      await remoteIo("reconnected");
      reconnectedForward = next;
      report.forwardProof = { oldPid: oldForward!.pid, newPid: next.pid, oldExited: true };
      report.reconnect = true;
    },
    async replaced(lease: DevelopmentSshLease) {
      diagnostics.phase("replacement");
      diagnostics.checkpoint("replacement");
      assert(report.reconnect && !closed);
      const candidate = validateSparkCanonicalConfig({
        ...config,
        remote: { ...config.remote, lease: { ...config.remote.lease, expected: lease } },
      }).remote.lease.expected;
      assert.equal(candidate.instanceId, remoteLease.instanceId);
      assert.notEqual(candidate.daemonId, remoteLease.daemonId);
      assert.notEqual(candidate.pid, remoteLease.pid);
      assert.notEqual(candidate.startedAt, remoteLease.startedAt);
      const oldDaemon = remoteLease.daemonId;
      remoteLease = candidate;
      writeDevelopmentRecord(route, {
        ...config,
        remote: { ...config.remote, lease: { ...config.remote.lease, expected: remoteLease } },
      });
      await timing.run("replacement", "forward-lookup", forward);
      assert(reconnectedForward);
      await timing.run("replacement", "forward-exit", () =>
        wait(async () => (await options.identify(reconnectedForward!.pid)) === null, 5000),
      );
      report.replacementProof = {
        oldDaemon,
        newDaemon: remoteLease.daemonId,
        oldForwardExited: true,
      };
      await remoteIo("replaced");
      report.replacement = true;
    },
    async close() {
      diagnostics.phase("cleanup");
      diagnostics.checkpoint("cleanup");
      if (closed) return;
      closed = true;
      lifetime.abort();
      report.cleanupReceipt = await tracker.dispose();
      await lifetime.settle();
      const routeChildren = readdirSync(root).filter((name) =>
        /^child-[a-f0-9-]{36}\.json$/u.test(name),
      );
      assert(routeChildren.length <= 128);
      // Even a short-lived wrapper that escaped ancestry capture must leave no child.
      // An ambiguous reused PID refuses cleanup; it never authorizes a signal.
      for (const name of routeChildren) {
        const child = readPrivateDevelopmentRecord<{ pid: number; wrapperPid: number }>(
          join(root, name),
        );
        assert(child);
        assert.equal(await options.identify(child.pid), null, "SSH child retirement unproven");
        assert.equal(
          await options.identify(child.wrapperPid),
          null,
          "SSH wrapper retirement unproven",
        );
      }
      assert.equal(admissions.size, clients.size, "Unconfirmed PTY admission retained");
      for (const client of clients.values()) {
        assert(client.exited && (await options.identify(client.pty.pid)) === null);
        client.vt.dispose();
        await withDevelopmentLock(instance, "lifecycle", async () => {
          const record = readPrivateDevelopmentRecord<{ attempt: string; pid: number }>(
            client.receipt,
          );
          assert(record?.attempt === client.attempt && record.pid === client.pty.pid);
          assert.equal(await developmentProcessIdentity(client.pty.pid), null);
          rmSync(client.receipt);
          admissions.delete(client.receipt);
        });
      }
      await localHealth();
      report.cleanup = true;
    },
    report: () => ({
      ...report,
      failure: diagnostics.report(),
      timings: timing.snapshot(),
      diagnosticReceipts: [...diagnosticReceipts],
      retainedTuiQualified: assessSparkRetainedTuiReport(report).qualified,
    }),
  };
  return {
    ...hooks,
    close: () =>
      (closeFlight ??= hooks
        .close()
        .catch((error) => {
          diagnostics.fail(error);
          throw error;
        })
        .finally(() => {
          if (report.cleanup) {
            for (const stream of diagnosticStreams) diagnosticReceipts.push(stream.close());
            diagnosticStreams.length = 0;
          }
          // On uncertain retirement, keep draining so a surviving writer is never orphaned.
        })),
    baseline: () => track(() => timing.run("baseline", "hook", hooks.baseline)),
    forwardLost: () => track(() => timing.run("forward-loss", "hook", hooks.forwardLost)),
    forwarded: () => track(() => timing.run("reconnect", "hook", hooks.forwarded)),
    replaced: (lease: DevelopmentSshLease) =>
      track(() => timing.run("replacement", "hook", () => hooks.replaced(lease))),
  };
}
