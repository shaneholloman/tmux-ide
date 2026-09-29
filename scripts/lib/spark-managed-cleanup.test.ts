import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSparkManagedInstance } from "./spark-managed-cleanup.ts";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spark-cleanup-")));
  const d = {
    nonce: "a".repeat(32),
    root,
    execution: {
      uid: process.getuid!(),
      bootId: "10000000-0000-4000-8000-000000000001",
      pidNamespace: "pid:[123]",
    },
    source: { path: root, commit: "b".repeat(40), tree: "c".repeat(40) },
    instance: { worktree: root, name: "spark-test", store: join(root, "store") },
    tools: {
      node: { path: "/node", sha256: "d".repeat(64) },
      bun: { path: "/bun", sha256: "e".repeat(64) },
      native: { path: "/tmux", sha256: "f".repeat(64) },
    },
  };
  const events: string[] = [];
  const io = {
    retireSecondary: async () => {
      events.push("secondary");
    },
    snapshot: async () => {
      events.push("snapshot");
      return { processes: [{ pid: 100, witness: "owned" }], port: 4321 };
    },
    logs: async () => {
      events.push("logs");
      return { records: [], readBytes: 0 };
    },
    manager: async (action: "down" | "status" | "reset") => {
      events.push(action);
      if (action === "reset") assert(existsSync(join(root, "cleanup-stopped.json")));
      return { state: "stopped", daemon: null, tmux: null };
    },
    witness: (_pid: number): string | null => {
      events.push("witness");
      return null;
    },
    socketAbsent: () => {
      events.push("socket");
      return true;
    },
    portClosed: async (_port: number) => {
      events.push("port");
    },
    registry: async () => {
      events.push("registry");
      return null;
    },
    resetVerified: () => {
      events.push("verified");
      return true;
    },
  };
  return { root, d, events, io, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("cleanup preserves private evidence and proves exit before supported reset", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await cleanupSparkManagedInstance(f.d, f.io), {
      cleaned: true,
      privateEvidenceRetained: true,
    });
    assert.deepEqual(f.events, [
      "secondary",
      "snapshot",
      "logs",
      "down",
      "status",
      "witness",
      "socket",
      "port",
      "registry",
      "reset",
      "verified",
    ]);
    for (const name of [
      "cleanup-before.json",
      "cleanup-logs.json",
      "cleanup-stopped.json",
      "cleanup-done.json",
    ]) {
      assert.equal(statSync(join(f.root, name)).mode & 0o777, 0o600);
      JSON.parse(readFileSync(join(f.root, name), "utf8"));
    }
    const prior = f.events.length;
    await assert.rejects(cleanupSparkManagedInstance(f.d, f.io), /EEXIST/);
    assert.equal(f.events.length, prior, "Retry must not guess at prior mutation outcome");
  } finally {
    f.dispose();
  }
});

test("uncertain secondary, process, socket, listener or registry prevents reset", async () => {
  for (const failure of ["secondary", "process", "socket", "listener", "registry", "status"]) {
    const f = fixture();
    try {
      if (failure === "secondary")
        f.io.retireSecondary = async () => {
          throw Error("uncertain");
        };
      if (failure === "process") f.io.witness = () => "replacement-process";
      if (failure === "socket") f.io.socketAbsent = () => false;
      if (failure === "listener")
        f.io.portClosed = async () => {
          throw Error("listener");
        };
      if (failure === "registry")
        f.io.registry = async () => {
          throw Error("unknown registry");
        };
      if (failure === "status")
        f.io.manager = async (action) => {
          f.events.push(action);
          return { state: "blocked", daemon: null, tmux: null };
        };
      await assert.rejects(cleanupSparkManagedInstance(f.d, f.io));
      assert(!f.events.includes("reset"), failure);
      assert(!existsSync(join(f.root, "cleanup-done.json")));
      assert(existsSync(join(f.root, "cleanup-attempt.json")));
    } finally {
      f.dispose();
    }
  }
});

test("incomplete reset retains evidence and does not report completion", async () => {
  const f = fixture();
  try {
    f.io.resetVerified = () => false;
    await assert.rejects(cleanupSparkManagedInstance(f.d, f.io), /reset incomplete/);
    assert(existsSync(join(f.root, "cleanup-stopped.json")));
    assert(!existsSync(join(f.root, "cleanup-done.json")));
  } finally {
    f.dispose();
  }
});
