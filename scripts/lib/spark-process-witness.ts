import assert from "node:assert/strict";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { linuxDevelopmentProcessIdentity } from "../../packages/daemon/src/lib/development-state.ts";

export interface SparkExecutionIdentity {
  bootId: string;
  pidNamespace: string;
  uid: number;
}
interface Probe {
  execution(): SparkExecutionIdentity;
  status(pid: number): string;
  identity(pid: number): string | null;
}
export function sparkExecutionIdentity(): SparkExecutionIdentity {
  assert.equal(process.platform, "linux");
  return {
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pidNamespace: readlinkSync("/proc/self/ns/pid"),
    uid: process.getuid!(),
  };
}
const probe: Probe = {
  execution: sparkExecutionIdentity,
  status: (pid) => readFileSync(`/proc/${pid}/status`, "utf8"),
  identity: (pid) =>
    linuxDevelopmentProcessIdentity(
      pid,
      () => readFileSync(`/proc/${pid}/stat`, "utf8"),
      () => realpathSync(`/proc/${pid}/exe`),
    ),
};

/** Qualification-only witness; a PID alone never authorizes a remote signal. */
export function sparkProcessWitness(
  pid: number,
  expected: SparkExecutionIdentity,
  io: Probe = probe,
): string | null {
  assert(Number.isSafeInteger(pid) && pid > 0);
  assert(/^[0-9a-f-]{36}$/u.test(expected.bootId));
  assert(/^pid:\[\d+\]$/u.test(expected.pidNamespace));
  assert(Number.isSafeInteger(expected.uid) && expected.uid > 0);
  assert.deepEqual(io.execution(), expected, "Remote execution identity changed");
  let identity: string | null;
  try {
    const before = io.identity(pid);
    const status = io.status(pid);
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/mu.exec(status);
    assert(
      uid && uid.slice(1).every((value) => Number(value) === expected.uid),
      "Process UID changed",
    );
    identity = io.identity(pid);
    assert.equal(identity, before, "Process incarnation changed during UID verification");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Confirm disappearance rather than treating a transient exe/status race as death.
    try {
      io.status(pid);
    } catch (confirmation) {
      if ((confirmation as NodeJS.ErrnoException).code !== "ENOENT") throw confirmation;
      assert.deepEqual(io.execution(), expected, "Remote execution identity changed");
      return null;
    }
    throw error;
  }
  assert.deepEqual(io.execution(), expected, "Remote execution identity changed");
  return identity === null ? null : JSON.stringify({ ...expected, pid, identity });
}
