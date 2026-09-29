/** Optional qualification harness instrumentation; never changes product timing budgets. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const phases = [
  "launch-epoch",
  "launcher-write-start",
  "launcher-write-end",
  "tmux-start",
  "tmux-return",
];
export function prepareStartupDiagnostic(root) {
  assert(isAbsolute(root));
  mkdirSync(root, { mode: 0o700 });
  const source = fileURLToPath(new URL("./startup-preexec.c", import.meta.url));
  const binary = join(root, "preexec");
  execFileSync(
    "/usr/bin/cc",
    ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary],
    {
      timeout: 30000,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
      stdio: "pipe",
    },
  );
  chmodSync(binary, 0o700);
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const provenance = {
    sourceSha256: hash(source),
    binarySha256: hash(binary),
    compiler: "/usr/bin/cc",
    purpose: "diagnostic-only; trampoline and logging overhead included",
    timingQualification: false,
  };
  writeFileSync(join(root, "provenance.json"), JSON.stringify(provenance), {
    mode: 0o600,
    flag: "wx",
  });
  return provenance;
}

export function startupLaunchDiagnostic(root, launchId) {
  if (!root) return null;
  assert(isAbsolute(root) && uuid.test(launchId));
  const directory = lstatSync(root);
  assert(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      directory.uid === process.getuid() &&
      (directory.mode & 0o777) === 0o700,
  );
  const binary = join(root, "preexec");
  const tool = lstatSync(binary);
  assert(
    tool.isFile() &&
      !tool.isSymbolicLink() &&
      tool.uid === process.getuid() &&
      (tool.mode & 0o777) === 0o700,
  );
  const path = join(root, `${launchId}.jsonl`);
  writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  const seen = new Set();
  return {
    path,
    wrap: (launch) => ({
      binary,
      binaryArgs: [path, launchId, launch.binary, ...launch.binaryArgs],
    }),
    mark: (phase, atMs = Date.now(), monotonicNs = process.hrtime.bigint()) => {
      assert(phases.includes(phase) && !seen.has(phase));
      seen.add(phase);
      appendFileSync(
        path,
        JSON.stringify({
          version: 1,
          launchId,
          phase,
          pid: process.pid,
          atMs,
          monotonicNs: monotonicNs.toString(),
          clock: "node-hrtime",
        }) + "\n",
      );
    },
  };
}

export function parseStartupLaunchDiagnostic(text, { launchId, lifecycleMarks }) {
  assert(typeof text === "string" && Buffer.byteLength(text) <= 16384);
  assert(uuid.test(launchId));
  assert(text.endsWith("\n"), "Incomplete launch diagnostic record");
  const records = text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, phases.length + 1, "Missing or extra launch boundaries");
  const map = new Map();
  for (const record of records) {
    assert(record.version === 1 && record.launchId === launchId);
    assert([...phases, "pre-exec"].includes(record.phase) && !map.has(record.phase));
    assert(Number.isSafeInteger(record.pid) && record.pid > 0 && Number.isFinite(record.atMs));
    assert(typeof record.monotonicNs === "string" && /^\d+$/u.test(record.monotonicNs));
    assert.equal(record.clock, record.phase === "pre-exec" ? "clock-monotonic" : "node-hrtime");
    map.set(record.phase, record);
  }
  const parent = phases.map((phase) => map.get(phase));
  for (let i = 1; i < parent.length; i++) {
    assert.equal(parent[i].pid, parent[0].pid);
    const wall = parent[i].atMs - parent[i - 1].atMs;
    const mono = Number(BigInt(parent[i].monotonicNs) - BigInt(parent[i - 1].monotonicNs)) / 1e6;
    assert(wall >= 0 && mono >= 0 && Math.abs(wall - mono) <= 20, "Parent clock discontinuity");
  }
  const entry = lifecycleMarks.find((mark) => mark.phase === "entry-start");
  const terminal = lifecycleMarks.find((mark) => mark.phase === "first-terminal-frame");
  assert(entry && Number.isFinite(entry.elapsedMs) && Number.isFinite(Date.parse(entry.at)));
  assert(terminal && Number.isFinite(terminal.elapsedMs) && terminal.elapsedMs >= entry.elapsedMs);
  assert.equal(terminal.processId, entry.processId, "Lifecycle process mismatch");
  const preexec = map.get("pre-exec");
  assert.equal(entry.processId, `opentui:${preexec.pid}`, "Pre-exec/product PID mismatch");
  assert(
    Math.abs(Date.parse(entry.at) - entry.elapsedMs - parent[0].atMs) <= 2,
    "Launch epoch mismatch",
  );
  assert(
    preexec.atMs >= map.get("tmux-start").atMs && preexec.atMs <= Date.parse(entry.at),
    "Invalid pre-exec boundary",
  );
  return {
    timingQualification: false,
    semantics:
      "Diagnostic overhead included; wall-clock cross-process intervals, monotonic clocks remain process-local",
    launchId,
    records,
    entry,
    intervalsMs: {
      fixtureBeforeTmux: map.get("tmux-start").atMs - parent[0].atMs,
      tmuxToPreexec: preexec.atMs - map.get("tmux-start").atMs,
      preexecToEntry: Date.parse(entry.at) - preexec.atMs,
      entryToTerminal: terminal.elapsedMs - entry.elapsedMs,
    },
  };
}
