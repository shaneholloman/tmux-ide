import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  parseStartupLaunchDiagnostic,
  retainStartupParentState,
  validateStartupParentWitness,
  prepareStartupDiagnostic,
  startupLaunchDiagnostic,
} from "./startup-launch-diagnostic.mjs";

const launchId = "10000000-0000-4000-8000-000000000001";
function fixture(returnMs = 8) {
  const parent = (phase, ms) => ({
    version: 1,
    launchId,
    phase,
    pid: 12,
    atMs: 1000 + ms,
    monotonicNs: String(ms * 1e6),
    clock: "node-hrtime",
  });
  const records = [
    parent("launch-epoch", 0),
    parent("launcher-write-start", 1),
    parent("launcher-write-end", 2),
    parent("tmux-start", 3),
    parent("tmux-return", returnMs),
    {
      version: 1,
      launchId,
      phase: "pre-exec",
      pid: 34,
      atMs: 1007.25,
      monotonicNs: "9999999999",
      clock: "clock-monotonic",
    },
  ];
  const lifecycleMarks = [
    {
      phase: "entry-start",
      elapsedMs: 100,
      at: new Date(1100).toISOString(),
      processId: "opentui:34",
    },
    {
      phase: "first-terminal-frame",
      elapsedMs: 400,
      at: new Date(1400).toISOString(),
      processId: "opentui:34",
    },
  ];
  const parse = () =>
    parseStartupLaunchDiagnostic(records.map((r) => JSON.stringify(r)).join("\n") + "\n", {
      launchId,
      lifecycleMarks,
    });
  return { records, lifecycleMarks, parse };
}

test("diagnostic separates fixture, process launch and runtime without comparing monotonic origins", () => {
  for (const returned of [5, 8]) {
    const f = fixture(returned);
    assert.deepEqual(f.parse().intervalsMs, {
      fixtureBeforeTmux: 3,
      tmuxToPreexec: 4.25,
      preexecToEntry: 92.75,
      entryToTerminal: 300,
    });
    assert.equal(f.parse().timingQualification, false);
  }
});

test("missing, duplicate, foreign and discontinuous clock records fail closed", () => {
  for (const corrupt of [
    (f) => f.records.pop(),
    (f) => {
      f.records[5] = f.records[4];
    },
    (f) => {
      f.records[5].launchId = "20000000-0000-4000-8000-000000000001";
    },
    (f) => {
      f.records[5].pid = 35;
    },
    (f) => {
      f.records[5].atMs = 1200;
    },
    (f) => {
      f.records[4].atMs = 1500;
    },
    (f) => {
      f.lifecycleMarks[0].elapsedMs = 150;
    },
    (f) => {
      f.lifecycleMarks[1].processId = "opentui:99";
    },
    (f) => {
      f.lifecycleMarks.pop();
    },
  ]) {
    const f = fixture();
    corrupt(f);
    assert.throws(f.parse);
  }
});

test("native trampoline records its PID, preserves argv, and refuses redirected logs", () => {
  const root = mkdtempSync(join(tmpdir(), "startup-marker-test-"));
  try {
    const directory = join(root, "private");
    const executions = [];
    const provenance = prepareStartupDiagnostic(directory, {
      execFile: (file, args, options) => {
        executions.push({ file, args });
        return execFileSync(file, args, options);
      },
    });
    assert.equal(executions.length, 2);
    assert.equal(executions[0].file, "/usr/bin/cc");
    assert.deepEqual(executions[1], {
      file: join(directory, "preexec"),
      args: [
        join(directory, "trampoline-prewarm.jsonl"),
        provenance.trampolinePrewarm.launchId,
        "/usr/bin/true",
      ],
    });
    const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(digest(join(directory, "preexec")), provenance.binarySha256);
    assert.equal(
      digest(join(directory, "trampoline-prewarm.jsonl")),
      provenance.trampolinePrewarm.logSha256,
    );
    assert.equal(provenance.trampolinePrewarm.productExecuted, false);
    assert.equal(statSync(join(directory, "trampoline-prewarm.jsonl")).mode & 0o777, 0o600);
    const prewarm = JSON.parse(readFileSync(join(directory, "trampoline-prewarm.jsonl"), "utf8"));
    assert.equal(prewarm.phase, "pre-exec");
    assert.equal(prewarm.launchId, provenance.trampolinePrewarm.launchId);
    assert.match(provenance.binarySha256, /^[0-9a-f]{64}$/u);
    const diagnostic = startupLaunchDiagnostic(directory, launchId);
    const wrapped = diagnostic.wrap({
      binary: "/usr/bin/printf",
      binaryArgs: ["%s", "literal $value ' argument"],
    });
    assert.equal(
      execFileSync(wrapped.binary, wrapped.binaryArgs, { encoding: "utf8" }),
      "literal $value ' argument",
    );
    const marker = JSON.parse(readFileSync(diagnostic.path, "utf8"));
    assert.equal(marker.phase, "pre-exec");
    assert.equal(marker.launchId, launchId);
    assert(marker.pid > 0 && marker.pid !== process.pid);
    const redirected = join(directory, "redirected");
    symlinkSync(diagnostic.path, redirected);
    const rejected = spawnSync(
      wrapped.binary,
      [redirected, launchId, "/usr/bin/printf", "must-not-exec"],
      { encoding: "utf8" },
    );
    assert.equal(rejected.status, 125);
    assert.equal(rejected.stdout, "");
    assert.throws(() => startupLaunchDiagnostic(directory, launchId), /EEXIST/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function parentFixture(root = "/private/diagnostic") {
  const diagnostic = fixture().parse();
  const parent = {
    version: 1,
    timingQualification: false,
    launchId,
    parentPid: 12,
    launchEpochMs: 1000,
    launchMonotonicNs: "0",
    processId: 34,
    hostIdentity: { processId: 34, paneId: "%1" },
    startupDiagnosticPath: join(root, `${launchId}.jsonl`),
  };
  const state = { launchId, processId: 34, startupDiagnosticPath: parent.startupDiagnosticPath };
  return { diagnostic, parent, state };
}

test("parent witness survives readiness failure and later active state overwrite", () => {
  const root = mkdtempSync(join(tmpdir(), "startup-parent-test-"));
  try {
    const { diagnostic, parent, state } = parentFixture(root);
    const path = retainStartupParentState(root, parent);
    // No readiness result is required to retain the parent evidence.
    const next = { ...parent, launchId: "20000000-0000-4000-8000-000000000001", processId: 99 };
    retainStartupParentState(root, next);
    writeFileSync(join(root, "state.json"), JSON.stringify(next));
    const retained = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(validateStartupParentWitness(diagnostic, retained, state).parentState, parent);
    assert.throws(() => validateStartupParentWitness(diagnostic, next, state), /witness mismatch/u);
    assert.throws(() => retainStartupParentState(root, parent), /EEXIST/u);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent witness rejects foreign launch, parent clock/PID and child identity", () => {
  for (const mutation of [
    { launchId: "20000000-0000-4000-8000-000000000001" },
    { parentPid: 13 },
    { launchEpochMs: 1001 },
    { launchMonotonicNs: "1" },
    { processId: 35 },
    { hostIdentity: { processId: 35 } },
    { startupDiagnosticPath: "/another/launch.jsonl" },
    { timingQualification: true },
  ]) {
    const { diagnostic, parent, state } = parentFixture();
    assert.throws(
      () => validateStartupParentWitness(diagnostic, { ...parent, ...mutation }, state),
      /witness mismatch/u,
    );
  }
});

test("failed trampoline prewarm aborts preparation before product can launch", () => {
  const root = mkdtempSync(join(tmpdir(), "startup-prewarm-failure-"));
  try {
    let calls = 0;
    assert.throws(
      () =>
        prepareStartupDiagnostic(join(root, "private"), {
          execFile: (file, args, options) => {
            calls += 1;
            if (file === "/usr/bin/cc") return execFileSync(file, args, options);
            assert.equal(args.at(-1), "/usr/bin/true");
            throw new Error("prewarm timeout");
          },
        }),
      /prewarm timeout/u,
    );
    assert.equal(calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
