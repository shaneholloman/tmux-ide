import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetainedTuiDiagnostics,
  RetainedTuiDeadline,
} from "./spark-retained-tui-diagnostics.ts";

test("first failed checkpoint keeps bounded private frame and no public secret text", () => {
  const root = mkdtempSync(join(tmpdir(), "retained-diagnostics-"));
  try {
    const frame = "private-token " + "界".repeat(20000);
    const diagnostics = createRetainedTuiDiagnostics(root, () => [
      { side: "local", frame, parsed: 7, bytes: 90000, exited: false },
    ]);
    diagnostics.checkpoint("home-frame", "local");
    diagnostics.fail(new RetainedTuiDeadline());
    diagnostics.checkpoint("cleanup");
    diagnostics.fail(new Error("private-password"));
    assert.deepEqual(diagnostics.report(), {
      phase: "baseline",
      checkpoint: "home-frame",
      side: "local",
      code: "deadline",
      privateFrames: true,
    });
    assert(!JSON.stringify(diagnostics.report()).includes("private-token"));
    const path = join(root, "failure-frames.json");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.frames[0].parsed, 7);
    assert(saved.frames[0].frame.startsWith("private-token"));
    assert(saved.frames[0].truncated);
    assert(Buffer.byteLength(saved.frames[0].frame) <= 16383);
    assert(statSync(path).size < 20000);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test("classifies assertion and cancellation without exporting their messages", () => {
  for (const [error, expected] of [
    [new assert.AssertionError({ message: "secret" }), "assertion"],
    [new DOMException("secret", "AbortError"), "cancelled"],
    [new Error("secret"), "unknown"],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), "retained-diagnostics-"));
    try {
      const diagnostics = createRetainedTuiDiagnostics(root, () => []);
      assert.equal(diagnostics.report(), null);
      diagnostics.fail(error);
      assert.equal(diagnostics.report()?.code, expected);
      assert(!JSON.stringify(diagnostics.report()).includes("secret"));
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});
test("failed snapshot preserves failure category and reports absent private evidence", () => {
  const diagnostics = createRetainedTuiDiagnostics("/unused", () => {
    throw new Error("disposed private frame");
  });
  diagnostics.checkpoint("terminal-frame", "remote");
  diagnostics.fail(new RetainedTuiDeadline());
  assert.deepEqual(diagnostics.report(), {
    phase: "baseline",
    checkpoint: "terminal-frame",
    side: "remote",
    code: "deadline",
    privateFrames: false,
  });
});
