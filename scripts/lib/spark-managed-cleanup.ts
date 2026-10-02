/** Qualification-only retirement; uncertainty retains the private source and evidence. */
import assert from "node:assert/strict";
import { preserveSparkDiagnostic, readSparkPrivateLog } from "./spark-private-diagnostics.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { lstatSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveDevelopmentInstance,
  validateDevelopmentDirectory,
  type DevelopmentInstance,
} from "../../packages/daemon/src/lib/development-instance.ts";
import {
  readTmux,
  statusDevelopmentInstance,
} from "../../packages/daemon/src/lib/development-lifecycle.ts";
import { developmentLogs } from "../../packages/daemon/src/lib/development-diagnostics.ts";
import {
  readDevelopmentOwner,
  readPrivateDevelopmentRecord,
} from "../../packages/daemon/src/lib/development-state.ts";
import { sparkManagerArgv, type SparkManagedDescriptor } from "./spark-managed-driver.ts";
import { sparkDriverEnvironment } from "./spark-driver-runtime.ts";
import { sparkProcessWitness } from "./spark-process-witness.ts";
import { sparkSecondaryAction } from "./spark-secondary.ts";
import { cleanupOwnedSshRegistry } from "./owned-ssh-registry-cleanup.ts";

type Descriptor = SparkManagedDescriptor & { nonce: string };
type Snapshot = {
  processes: Array<{ pid: number; witness: string | null }>;
  port: number | null;
};
interface CleanupIO {
  retireSecondary(): Promise<unknown>;
  snapshot(): Promise<Snapshot>;
  logs(): Promise<unknown>;
  manager(action: "down" | "status" | "reset"): Promise<unknown>;
  witness(pid: number): string | null;
  socketAbsent(): boolean;
  portClosed(port: number): Promise<void>;
  registry(): Promise<unknown>;
  resetVerified(): boolean;
}
function absent(path: string) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
function stopped(value: unknown) {
  const status = value as { state?: string; daemon?: unknown; tmux?: unknown };
  assert(
    status && status.state === "stopped" && status.daemon === null && status.tmux === null,
    "Managed stop is not proven; retain private evidence",
  );
}

/** Admit only manager-owned root entries, including its canonical state directory
 * and consumed launch records that match a schema-validated process owner. */
export function verifySparkCleanupEntries(instance: DevelopmentInstance) {
  const known = new Set([
    "activation.json",
    "apps",
    "artifacts",
    "build-receipt.json",
    "build.json",
    "instance.json",
    "locks",
    "logs",
    "owner.json",
    "reset.json",
    "startup-process.json",
    "startup-receipt.json",
    "startup.json",
    "tmux-startup.json",
    "tmux.json",
  ]);
  const owners = [
    readDevelopmentOwner(instance),
    readDevelopmentOwner(instance, "startup-process.json"),
  ];
  const names = readdirSync(instance.root);
  assert(names.length <= 256, "Managed instance entry budget exceeded");
  for (const name of names) {
    if (known.has(name)) continue;
    if (name === "state") {
      assert.equal(instance.stateHome, join(instance.root, "state"));
      validateDevelopmentDirectory(instance.stateHome, instance.store);
      continue;
    }
    assert(
      /^launch-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u.test(name),
      "Unknown managed instance entries; retain evidence",
    );
    const record = readPrivateDevelopmentRecord<{ version: number; attempt: string; pid: number }>(
      join(instance.root, name),
    );
    assert(record, "Consumed launch is missing");
    assert.deepEqual(Object.keys(record).sort(), ["attempt", "pid", "version"]);
    assert.equal(record.version, 1);
    assert.equal(name, `launch-${record.attempt}.json`);
    assert(
      owners.some((owner) => owner?.attempt === record.attempt && owner.pid === record.pid),
      "Consumed launch has no matching managed process owner",
    );
  }
}
function provePortClosed(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(1000, () => finish(new Error("Managed listener absence is uncertain")));
    socket.once("connect", () => finish(new Error("Managed listener still exists")));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? undefined : error),
    );
  });
}

/** Caller holds the driver lock and has completed descriptor/runtime preflight.
 * A prior cleanup attempt deliberately requires review, rather than guessing at partial success.
 */
export async function cleanupSparkManagedInstance(d: Descriptor, testIO?: CleanupIO) {
  const instance = resolveDevelopmentInstance(d.instance);
  const execute = promisify(execFile);
  const io: CleanupIO = testIO ?? {
    retireSecondary: () => sparkSecondaryAction(d, "secondary-retire"),
    snapshot: async () => {
      const status = await statusDevelopmentInstance(instance);
      assert(["ready", "stopped"].includes(status.state), "Managed ownership is uncertain");
      verifySparkCleanupEntries(instance);
      const records = [
        readDevelopmentOwner(instance),
        readDevelopmentOwner(instance, "startup-process.json"),
        readTmux(instance),
      ].filter((record) => record !== null);
      const processes = records.map((record) => {
        const witness = sparkProcessWitness(record.pid, d.execution);
        if (witness !== null)
          assert.equal(
            JSON.parse(witness).identity,
            record.incarnation,
            "Managed incarnation changed",
          );
        return { pid: record.pid, witness };
      });
      return { processes, port: status.daemon?.port ?? null };
    },
    logs: async () => {
      let structured: unknown, privateOwner: unknown;
      await Promise.all([
        preserveSparkDiagnostic(
          () => developmentLogs(instance),
          (value) => {
            structured = value;
          },
          1000,
        ),
        preserveSparkDiagnostic(
          () => readSparkPrivateLog(join(instance.root, "logs/owner.log")),
          (value) => {
            privateOwner = value;
          },
          1000,
        ),
      ]);
      return { structured, privateOwner };
    },
    manager: async (action) => {
      // Replacement uses daemon-only down; cleanup must retire the full private server.
      const argv = sparkManagerArgv(d, action).filter((arg) => arg !== "--daemon-only");
      const result = await execute(d.tools.node.path, argv, {
        cwd: d.source.path,
        env: {
          ...sparkDriverEnvironment(d.root),
          PATH: `${dirname(d.tools.node.path)}:${dirname(d.tools.bun.path)}:/usr/bin:/bin`,
        },
        encoding: "utf8",
        timeout: 60000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(result.stdout);
    },
    witness: (pid) => sparkProcessWitness(pid, d.execution),
    socketAbsent: () => absent(join(instance.runtimeDir, "tmux.sock")),
    portClosed: provePortClosed,
    registry: async () => {
      verifySparkCleanupEntries(instance);
      if (absent(join(instance.runtimeDir, "server-owners"))) return null;
      const receipt = readPrivateDevelopmentRecord<{
        version: number;
        nonce: string;
        socket: string;
        serverId: string;
      }>(join(d.root, "secondary-registration.json"));
      assert(receipt, "Secondary registry provenance is absent; retain runtime");
      assert.deepEqual(Object.keys(receipt).sort(), ["nonce", "serverId", "socket", "version"]);
      assert.equal(receipt.version, 1);
      assert.equal(receipt.nonce, d.nonce);
      assert.equal(receipt.socket, join(d.root, "secondary.sock"));
      assert(/^tmux-server\.[a-f0-9]{32}$/u.test(receipt.serverId));
      return cleanupOwnedSshRegistry(instance, receipt.serverId);
    },
    resetVerified: () => {
      // The supported manager deliberately retains its lock scaffold and reset tombstone.
      assert.deepEqual(readdirSync(instance.root).sort(), ["locks", "reset.json"]);
      const reset = readPrivateDevelopmentRecord<{ id: string }>(join(instance.root, "reset.json"));
      assert.equal(reset?.id, instance.id);
      return absent(instance.runtimeDir);
    },
  };
  const save = (name: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    assert(Buffer.byteLength(bytes) <= 1024 * 1024, "Cleanup evidence exceeded bound");
    writeFileSync(join(d.root, name), bytes, { flag: "wx", mode: 0o600 });
  };
  save("cleanup-attempt.json", { version: 1, nonce: d.nonce });
  await io.retireSecondary();
  const before = await io.snapshot();
  save("cleanup-before.json", before);
  const logs = await preserveSparkDiagnostic(io.logs, (value) => save("cleanup-logs.json", value));
  await io.manager("down");
  const status = await io.manager("status");
  stopped(status);
  for (const process of before.processes)
    assert.equal(io.witness(process.pid), null, "Previously recorded process is not proven exited");
  assert(io.socketAbsent(), "Managed socket persists; retain runtime");
  if (before.port !== null) await io.portClosed(before.port);
  const registry = await io.registry();
  save("cleanup-stopped.json", { version: 1, status, registry });
  await io.manager("reset");
  assert(io.resetVerified(), "Managed reset incomplete; retain private evidence");
  save("cleanup-done.json", {
    version: 1,
    stopped: true,
    reset: true,
    logsCaptured: logs.captured,
  });
  return { cleaned: true, privateEvidenceRetained: true };
}
