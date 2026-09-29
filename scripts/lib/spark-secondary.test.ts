import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { sparkSecondaryAction } from "./spark-secondary.ts";

function fixture() {
  const nonce = randomBytes(16).toString("hex");
  const root = `/tmp/tia-ssh-${nonce}`;
  mkdirSync(root, { mode: 0o700 });
  // Model Linux's canonical /tmp when running these fixture tests on macOS.
  const realpath = fs.realpathSync;
  const canonical = mock.method(
    fs,
    "realpathSync",
    (...args: Parameters<typeof fs.realpathSync>) => (args[0] === root ? root : realpath(...args)),
  );
  syncBuiltinESMExports();
  const descriptor = {
    root,
    nonce,
    execution: {
      uid: process.getuid!(),
      bootId: "10000000-0000-4000-8000-000000000001",
      pidNamespace: "pid:[123]",
    },
    tools: { native: { path: "/unused/tmux" } },
  };
  const calls: string[][] = [];
  let witness: string | null = "linux-owned-incarnation";
  let valid = true;
  let failStart = false;
  let killed = false;
  const io = {
    run: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "new-session" && failStart) throw Error("start failed");
      if (args[4] === "'kill-server'") {
        witness = null;
        killed = true;
      }
      return "";
    },
    observe: async () => ({
      nativeServerIdentity: { pid: "12", startTime: "45" },
      fingerprint: "fixed",
      authority: {
        executablePath: "/unused/tmux",
        socketSelector: { kind: "path" as const, path: `${root}/secondary.sock` },
      },
      valid: () => valid,
    }),
    witness: () => witness,
    capture: () => ({
      path: `${root}/secondary.sock`,
      dev: 1,
      ino: 2,
      mtimeNs: 3n,
      birthtimeNs: 4n,
    }),
    revalidate: () => {
      assert(valid, "socket replaced");
      return `${root}/secondary.sock`;
    },
    sleep: async () => {
      throw Error("exit unproven");
    },
  };
  return {
    descriptor,
    calls,
    io,
    changeWitness: () => {
      witness = "different";
    },
    replaceSocket: () => {
      valid = false;
    },
    failStart: () => {
      failStart = true;
    },
    killed: () => killed,
    cleanup: () => {
      canonical.mock.restore();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("fixed secondary lifecycle persists and revalidates between invocations", async () => {
  const f = fixture();
  try {
    const started = await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
    assert.equal(started.socket, `${f.descriptor.root}/secondary.sock`);
    await sparkSecondaryAction(f.descriptor, "secondary-probe", f.io);
    await sparkSecondaryAction(f.descriptor, "secondary-seed", f.io);
    assert(f.calls.some((args) => args.some((arg) => arg.includes("pane.shared"))));
    assert(f.calls.some((args) => args.some((arg) => arg.includes("owned-secondary-marker"))));
    assert.deepEqual(await sparkSecondaryAction(f.descriptor, "secondary-retire", f.io), {
      retired: true,
    });
    assert(f.killed());
    assert.equal(
      JSON.parse(readFileSync(`${f.descriptor.root}/secondary.json`, "utf8")).phase,
      "retired",
    );
    const kill = f.calls.find((args) => args[4] === "'kill-server'")!;
    assert.equal(kill[3], "#{&&:#{==:#{pid},12},#{==:#{start_time},45}}");
    await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-start", f.io));
  } finally {
    f.cleanup();
  }
});
test("failed creation retains an attempt and never retries or kills", async () => {
  const f = fixture();
  try {
    f.failStart();
    await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-start", f.io));
    await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-start", f.io));
    await assert.rejects(
      sparkSecondaryAction(f.descriptor, "secondary-retire", f.io),
      /no admitted witness/,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(
      JSON.parse(readFileSync(`${f.descriptor.root}/secondary.json`, "utf8")).phase,
      "attempted",
    );
  } finally {
    f.cleanup();
  }
});
test("changed socket or process blocks every later mutation", async () => {
  for (const change of ["replaceSocket", "changeWitness"] as const) {
    const f = fixture();
    try {
      await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
      const count = f.calls.length;
      f[change]();
      await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-seed", f.io));
      await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-retire", f.io));
      assert.equal(f.calls.length, count);
      assert(!f.killed());
    } finally {
      f.cleanup();
    }
  }
});
test("unprivate state and leftover action locks fail closed", async () => {
  const f = fixture();
  try {
    await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
    chmodSync(`${f.descriptor.root}/secondary.json`, 0o644);
    await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-seed", f.io));
    writeFileSync(`${f.descriptor.root}/secondary.lock`, "", { mode: 0o600 });
    await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-retire", f.io));
    assert(!f.killed());
  } finally {
    f.cleanup();
  }
});

test("unconfirmed exit retains retiring proof and never issues a second kill", async () => {
  const f = fixture();
  try {
    await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
    const original = f.io.run;
    f.io.run = async (args) => {
      if (args[4] === "'kill-server'") {
        f.calls.push(args);
        return "";
      }
      return original(args);
    };
    await assert.rejects(
      sparkSecondaryAction(f.descriptor, "secondary-retire", f.io),
      /exit unproven/,
    );
    assert.equal(
      JSON.parse(readFileSync(`${f.descriptor.root}/secondary.json`, "utf8")).phase,
      "retiring",
    );
    await assert.rejects(
      sparkSecondaryAction(f.descriptor, "secondary-retire", f.io),
      /exit unproven/,
    );
    assert.equal(f.calls.filter((args) => args[4] === "'kill-server'").length, 1);
  } finally {
    f.cleanup();
  }
});

test("post-check generation replacement refuses stamp, seed and retirement", async () => {
  for (const action of ["secondary-start", "secondary-seed", "secondary-retire"] as const) {
    const f = fixture();
    try {
      if (action !== "secondary-start")
        await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
      const original = f.io.run;
      let refusals = 0;
      f.io.run = async (args) => {
        if (args[0] !== "-N") return original(args);
        assert.equal(args[1], "if-shell");
        assert.equal(args[3], "#{&&:#{==:#{pid},12},#{==:#{start_time},45}}");
        const refusal = /^display-message -p '(tmux-server-stale\.[^']+)'$/u.exec(args[5]!);
        assert(refusal);
        refusals += 1;
        // Model another server accepting the connection after verify succeeded.
        return refusal[1]!;
      };
      await assert.rejects(
        sparkSecondaryAction(f.descriptor, action, f.io),
        /generation changed before command execution/,
      );
      assert.equal(refusals, 1);
      assert(!f.killed());
      const state = JSON.parse(readFileSync(`${f.descriptor.root}/secondary.json`, "utf8"));
      assert.equal(state.phase, action === "secondary-retire" ? "retiring" : "live");
    } finally {
      f.cleanup();
    }
  }
});

test("retirement removes only a revalidated stale socket after proven process exit", async () => {
  for (const replaced of [false, true]) {
    const f = fixture();
    try {
      await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
      const socket = `${f.descriptor.root}/secondary.sock`;
      // Socket inode/type admission is supplied by this fixture's revalidator.
      writeFileSync(socket, "socket-fixture");
      const original = f.io.run;
      f.io.run = async (args) => {
        const result = await original(args);
        if (f.killed() && replaced) f.replaceSocket();
        return result;
      };
      if (replaced) {
        await assert.rejects(
          sparkSecondaryAction(f.descriptor, "secondary-retire", f.io),
          /socket replaced/,
        );
        assert(existsSync(socket));
        assert.equal(
          JSON.parse(readFileSync(`${f.descriptor.root}/secondary.json`, "utf8")).phase,
          "retiring",
        );
      } else {
        await sparkSecondaryAction(f.descriptor, "secondary-retire", f.io);
        assert(!existsSync(socket));
      }
      assert(f.killed());
    } finally {
      f.cleanup();
    }
  }
});

test("retirement persists bounded safe command diagnostics without treating lost replies as exit proof", async () => {
  const f = fixture();
  try {
    await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
    const socket = `${f.descriptor.root}/secondary.sock`;
    writeFileSync(socket, "socket-fixture");
    const original = f.io.run;
    f.io.run = async (args) => {
      const result = await original(args);
      if (args[4] === "'kill-server'")
        throw Object.assign(new Error("PRIVATE COMMAND OUTPUT"), {
          code: 1,
          stdout: "PRIVATE TOKEN",
          stderr: "PRIVATE STDERR",
        });
      return result;
    };
    await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-retire", f.io));
    const bytes = readFileSync(`${f.descriptor.root}/secondary.json`, "utf8");
    const retained = JSON.parse(bytes);
    assert.equal(retained.phase, "retiring");
    assert.deepEqual(retained.retirementDiagnostic, {
      stage: "command-execution",
      code: "command-exit",
    });
    assert(!bytes.includes("PRIVATE"));
    assert(existsSync(socket));
    // A separately invoked retry can prove disappearance and exact socket authority;
    // the failed command itself is never accepted as retirement evidence.
    await sparkSecondaryAction(f.descriptor, "secondary-retire", f.io);
    assert.equal(f.calls.filter((args) => args[4] === "'kill-server'").length, 1);
    assert(!existsSync(socket));
  } finally {
    f.cleanup();
  }
});

test("exit proof retries transient missing proc reads until a confirmed null witness", async () => {
  const f = fixture();
  try {
    await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
    const original = f.io.witness;
    let exitReads = 0;
    let sleeps = 0;
    f.io.witness = () => {
      if (f.killed() && ++exitReads === 1)
        throw Object.assign(new Error("transient proc read"), { code: "ENOENT" });
      return original();
    };
    f.io.sleep = async () => {
      sleeps += 1;
    };
    await sparkSecondaryAction(f.descriptor, "secondary-retire", f.io);
    assert.equal(exitReads, 2);
    assert.equal(sleeps, 1);
    assert.equal(
      JSON.parse(readFileSync(`${f.descriptor.root}/secondary.json`, "utf8")).phase,
      "retired",
    );
  } finally {
    f.cleanup();
  }
});

test("persistent missing exit reads stop at the existing deadline and retain proof", async () => {
  const f = fixture();
  let now = 0;
  const clock = mock.method(Date, "now", () => now);
  try {
    await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
    const original = f.io.witness;
    let sleeps = 0;
    f.io.witness = () => {
      if (f.killed()) throw Object.assign(new Error("missing proc"), { code: "ENOENT" });
      return original();
    };
    f.io.sleep = async () => {
      sleeps += 1;
      now += 1000;
    };
    await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-retire", f.io), {
      code: "ENOENT",
    });
    assert.equal(sleeps, 3);
    const state = JSON.parse(readFileSync(`${f.descriptor.root}/secondary.json`, "utf8"));
    assert.equal(state.phase, "retiring");
    assert.deepEqual(state.retirementDiagnostic, { stage: "exit-proof", code: "io-not-found" });
  } finally {
    clock.mock.restore();
    f.cleanup();
  }
});

test("nonmissing exit errors are refused immediately with closed diagnostics", async () => {
  for (const [code, diagnostic] of [
    ["EACCES", "io-permission"],
    ["EPERM", "io-permission"],
    ["ESRCH", "io-process-gone"],
  ]) {
    const f = fixture();
    try {
      await sparkSecondaryAction(f.descriptor, "secondary-start", f.io);
      const original = f.io.witness;
      let sleeps = 0;
      f.io.witness = () => {
        if (f.killed()) throw Object.assign(new Error("private io detail"), { code });
        return original();
      };
      f.io.sleep = async () => {
        sleeps += 1;
      };
      await assert.rejects(sparkSecondaryAction(f.descriptor, "secondary-retire", f.io), { code });
      assert.equal(sleeps, 0);
      const state = JSON.parse(readFileSync(`${f.descriptor.root}/secondary.json`, "utf8"));
      assert.equal(state.phase, "retiring");
      assert.deepEqual(state.retirementDiagnostic, { stage: "exit-proof", code: diagnostic });
    } finally {
      f.cleanup();
    }
  }
});
