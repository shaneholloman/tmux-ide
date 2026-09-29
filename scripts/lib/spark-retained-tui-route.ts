/** Closed PATH adapter for a real compiled TUI. No alternative daemon transport. */
import assert from "node:assert/strict";
import {
  teeSparkRouteStderr,
  createSparkRouteLifecycle,
  createSparkPrivateStderr,
  preserveSparkDiagnostic,
} from "./spark-private-diagnostics.ts";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { readSparkCanonicalConfig } from "../qualify-spark-canonical.ts";
import { sparkQualificationSshArgs } from "./spark-qualification-ssh.mjs";
import {
  readPrivateDevelopmentRecord,
  writeDevelopmentRecord,
} from "../../packages/daemon/src/lib/development-state.ts";

export function retainedTuiSshArgv(
  config: ReturnType<typeof readSparkCanonicalConfig>,
  argv: string[],
) {
  assert(argv.length <= 32 && argv.every((arg) => arg.length <= 4096));
  return [
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    ...sparkQualificationSshArgs(argv, {
      alias: config.ssh.alias,
      config: config.ssh.config,
      node: config.remote.driver.tools.node.path,
      dispatcher: `${config.remote.driver.source.path}/scripts/spark-qualification-handshake.mjs`,
      descriptor: `${config.remote.driver.root}/lease.json`,
      port: config.remote.lease.expected.port,
    }),
  ];
}
export async function runRetainedTuiSsh(route: string, argv: string[]) {
  const config = readSparkCanonicalConfig(route);
  const root = dirname(route);
  const stat = lstatSync(root);
  assert(
    realpathSync(root) === root &&
      stat.isDirectory() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === 0o700,
  );
  const args = retainedTuiSshArgv(config, argv);
  if (existsSync(join(root, "hold.json"))) {
    assert.deepEqual(readPrivateDevelopmentRecord(join(root, "hold.json")), { held: true });
    // Production transport receives its ordinary retryable unavailable vocabulary.
    if (!argv.includes("-L"))
      process.stdout.write(JSON.stringify({ version: 1, error: { code: "unavailable" } }) + "\n");
    return 1;
  }
  const lifecycle = createSparkRouteLifecycle();
  const receipt = join(root, `child-${randomUUID()}.json`);
  let spawnError = false;
  const stderr = createSparkPrivateStderr(receipt.replace(/\.json$/u, ".stderr"));
  const child = spawn("/usr/bin/ssh", args, {
    env: { PATH: "/usr/bin:/bin", HOME: root },
    stdio: ["ignore", "inherit", "pipe"],
  });
  if (child.stderr) teeSparkRouteStderr(child.stderr, process.stderr, stderr);
  const closed = new Promise<number>((done) => {
    child.once("error", () => {
      spawnError = true;
    });
    child.once("close", (code) => done(code ?? 1));
  });
  if (!child.pid) {
    await closed;
    stderr.close();
    throw Error("Private SSH child did not start");
  }
  const record = {
    version: 1,
    wrapperPid: process.pid,
    pid: child.pid,
    kind: argv.includes("-L") ? "forward" : "discovery",
    daemonId: config.remote.lease.expected.daemonId,
    port: config.remote.lease.expected.port,
  };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    lifecycle.stop();
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 250);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    writeFileSync(receipt, JSON.stringify(record), {
      mode: 0o600,
      flag: "wx",
    });
    return await closed;
  } catch (error) {
    stop();
    await closed;
    throw error;
  } finally {
    await preserveSparkDiagnostic(
      () => ({
        ...record,
        lifecycle: lifecycle.closed(child.exitCode, child.signalCode, spawnError),
        stderr: stderr.close(),
      }),
      (value) => writeDevelopmentRecord(receipt, Object.assign({}, record, value)),
    );
    if (escalation) clearTimeout(escalation);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runRetainedTuiSsh(process.argv[2]!, process.argv.slice(3));
  } catch {
    process.stderr.write("Private retained TUI SSH route refused\n");
    process.exitCode = 1;
  }
}
