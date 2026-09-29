import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  sparkTuiInput,
  sparkTuiAdmission,
  assessSparkRetainedTuiReport,
  createRetainedTuiWorkLifetime,
} from "./spark-retained-tui.ts";
import { retainedTuiSshArgv } from "./spark-retained-tui-route.ts";

test("typed shell echo cannot satisfy the unique parsed-output marker", () => {
  const probe = sparkTuiInput("a".repeat(32));
  assert(!probe.command.includes(probe.marker));
  assert.equal(
    execFileSync("/bin/sh", ["-c", probe.command.trim()], { encoding: "utf8" }),
    probe.marker + "\n",
  );
  for (const token of ["short", "A".repeat(32), "a".repeat(31) + ";", "a".repeat(33)])
    assert.throws(() => sparkTuiInput(token));
});
function report() {
  const frames: Record<string, unknown>[] = [];
  for (const side of ["local", "remote"]) {
    const stages =
      side === "local"
        ? ["baseline", "remote-forward-offline", "reconnected", "replaced"]
        : ["baseline", "reconnected", "replaced"];
    for (const stage of stages) {
      const inputMarker = "TUI_INPUT_" + String(frames.length).padStart(32, "a");
      const outputMarker = side === "remote" ? `SPARK_TUI_${stage.toUpperCase()}` : null;
      const frame = [inputMarker, outputMarker ?? ""].join("\n");
      frames.push({
        side,
        stage,
        pid: side === "remote" ? 101 : 102,
        witness: `birth-${side}`,
        parsedChunks: 1,
        inputMarker,
        outputMarker,
        frame,
        frameSha256: createHash("sha256").update(frame).digest("hex"),
      });
    }
  }
  return {
    baseline: true,
    forwardLoss: true,
    reconnect: true,
    replacement: true,
    localSibling: true,
    cleanup: true,
    frames,
    forwardProof: { oldPid: 201, newPid: 202, oldExited: true },
    replacementProof: { oldDaemon: "old", newDaemon: "new", oldForwardExited: true },
    cleanupReceipt: { closed: true, roots: 2 },
  };
}
test("requires retained independent PTYs and parsed input/output at all stages", () => {
  assert.equal(assessSparkRetainedTuiReport(report()).qualified, true);
  for (const change of [
    (r: ReturnType<typeof report>) => {
      r.forwardProof.oldExited = false;
    },
    (r: ReturnType<typeof report>) => {
      r.replacementProof.newDaemon = "old";
    },
    (r: ReturnType<typeof report>) => {
      r.cleanupReceipt.roots = 1;
    },
    (r: ReturnType<typeof report>) => {
      r.cleanup = false;
    },
    (r: ReturnType<typeof report>) => {
      r.forwardLoss = false;
    },
    (r: ReturnType<typeof report>) => {
      r.frames.pop();
    },
    (r: ReturnType<typeof report>) => {
      r.frames[0]!.pid = 1000;
    },
    (r: ReturnType<typeof report>) => {
      r.frames[0]!.witness = "other";
    },
    (r: ReturnType<typeof report>) => {
      r.frames[0]!.parsedChunks = 0;
    },
    (r: ReturnType<typeof report>) => {
      r.frames.at(-1)!.outputMarker = "SPARK_TUI_BASELINE";
    },
    (r: ReturnType<typeof report>) => {
      r.frames.at(-1)!.frame = "typed shell command only";
    },
    (r: ReturnType<typeof report>) => {
      r.frames[1]!.stage = "baseline";
    },
  ]) {
    const r = report();
    change(r);
    assert.equal(assessSparkRetainedTuiReport(r).qualified, false);
  }
});

test("private route admits only the product discovery and exact leased loopback forward", () => {
  const config = {
    ssh: { alias: "spark-private", config: "/private/ssh.config" },
    remote: {
      driver: {
        tools: { node: { path: "/private/node" } },
        source: { path: "/private/source" },
        root: "/tmp/tia-ssh-" + "a".repeat(32),
      },
      lease: { expected: { port: 1234 } },
    },
  } as Parameters<typeof retainedTuiSshArgv>[0];
  const discovery = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ForkAfterAuthentication=no",
    "--",
    "spark-private",
    "tmux-ide",
    "remote-daemon-info",
    "--json",
  ];
  const translated = retainedTuiSshArgv(config, discovery);
  assert(translated.includes("StrictHostKeyChecking=yes"));
  assert(translated.at(-1)!.includes("spark-qualification-handshake.mjs"));
  const tunnel = [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ForkAfterAuthentication=no",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    "127.0.0.1:4321:127.0.0.1:1234",
    "--",
    "spark-private",
  ];
  assert(retainedTuiSshArgv(config, tunnel).includes("127.0.0.1:4321:127.0.0.1:1234"));
  for (const args of [
    ["spark-private", "sh"],
    discovery.map((s) => (s === "spark-private" ? "default" : s)),
    tunnel.map((s) => (s.includes(":1234") ? s.replace(":1234", ":9999") : s)),
    [...tunnel, "extra"],
  ])
    assert.throws(() => retainedTuiSshArgv(config, args));
});

test("cleanup cancels observer work and refuses unsettled or new hooks", async () => {
  const owner = createRetainedTuiWorkLifetime(new AbortController().signal);
  await assert.rejects(owner.settle(10), /stop new observer work/u);
  const pending = owner.track(
    () =>
      new Promise<void>((_, reject) => {
        owner.signal.addEventListener("abort", () => reject(Error("cancelled")), { once: true });
      }),
  );
  owner.abort();
  await assert.rejects(pending, /cancelled/u);
  await owner.settle(10);
  assert.throws(() => owner.track(async () => {}));
  const stuck = createRetainedTuiWorkLifetime(new AbortController().signal);
  let rejectLate!: (error: Error) => void;
  stuck.track(
    () =>
      new Promise<void>((_, reject) => {
        rejectLate = reject;
      }),
  );
  stuck.abort();
  await assert.rejects(stuck.settle(10), /retirement unproven/u);
  rejectLate(Error("late rejection is consumed"));
  await stuck.settle(10);
});

test("startup admits Home selection or sole-session automatic open without Enter in terminal", () => {
  assert.equal(
    sparkTuiAdmission(
      "F1 Home  F2 Terminals\nYour agents, across your machines\nattribution-collision",
    ),
    "home",
  );
  assert.equal(sparkTuiAdmission("F1 Home  F2 Terminals\nattribution-collision\n$"), "terminal");
  for (const frame of [
    "Loading attribution-collision",
    "Terminals F2 attribution-collision",
    "F2 Terminals attribution-collision PASSIVE PREVIEW",
    "F2 Terminals another-session",
    "F2 Terminals attribution-collision-other",
    "Your agents, across your machines",
  ])
    assert.equal(sparkTuiAdmission(frame), null);
});
