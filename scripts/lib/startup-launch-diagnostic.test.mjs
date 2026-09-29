import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  parseStartupLaunchDiagnostic,
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
    const provenance = prepareStartupDiagnostic(directory);
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
