import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSparkManagedInstance, verifySparkCleanupEntries } from "./spark-managed-cleanup.ts";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";

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

test("cleanup admits canonical private state and only launch records matching managed owners", () => {
  const f = fixture();
  try {
    const instance = resolveDevelopmentInstance(f.d.instance);
    mkdirSync(instance.stateHome, { recursive: true, mode: 0o700 });
    const attempt = "10000000-0000-4000-8000-000000000001";
    const owner = {
      version: 1,
      attempt,
      pid: 123,
      incarnation: "linux:123:/node",
      generation: "build-" + attempt,
      manifestHash: "a".repeat(64),
    };
    writeFileSync(join(instance.root, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
    const path = join(instance.root, `launch-${attempt}.json`);
    const writeLaunch = (value: unknown) =>
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    writeLaunch({ version: 1, attempt, pid: 123 });
    verifySparkCleanupEntries(instance);
    writeLaunch({ version: 1, attempt, pid: 456 });
    assert.throws(() => verifySparkCleanupEntries(instance), /no matching managed process owner/);
    writeLaunch({ version: 2, attempt, pid: 123 });
    assert.throws(() => verifySparkCleanupEntries(instance));
    writeLaunch({ version: 1, attempt, pid: 123, extra: true });
    assert.throws(() => verifySparkCleanupEntries(instance));
    writeLaunch({ version: 1, attempt, pid: 123 });
    writeFileSync(join(instance.root, "unexpected"), "retain");
    assert.throws(() => verifySparkCleanupEntries(instance), /Unknown managed instance/);
    rmSync(join(instance.root, "unexpected"));
    rmSync(instance.stateHome, { recursive: true });
    symlinkSync(f.root, instance.stateHome);
    assert.throws(() => verifySparkCleanupEntries(instance), /Unsafe development directory/);
  } finally {
    f.dispose();
  }
});

test("failed log capture or evidence write never skips supported retirement", async () => {
  for (const failure of ["capture", "save"]) {
    const f = fixture();
    try {
      if (failure === "capture")
        f.io.logs = async () => {
          throw Error("private log unavailable");
        };
      else writeFileSync(join(f.root, "cleanup-logs.json"), "preserve existing", { mode: 0o600 });
      await cleanupSparkManagedInstance(f.d, f.io);
      assert(f.events.includes("down") && f.events.includes("reset"));
      assert.equal(
        JSON.parse(readFileSync(join(f.root, "cleanup-done.json"), "utf8")).logsCaptured,
        false,
      );
    } finally {
      f.dispose();
    }
  }
});
