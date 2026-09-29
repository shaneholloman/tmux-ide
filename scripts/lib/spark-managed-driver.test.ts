import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sparkManagerArgv,
  sparkTuiOutput,
  sparkManagedAction,
  type SparkManagedDescriptor,
} from "./spark-managed-driver.ts";

const root = "/tmp/tia-ssh-" + "a".repeat(32);
const descriptor: SparkManagedDescriptor = {
  root,
  execution: {
    uid: 1000,
    bootId: "10000000-0000-4000-8000-000000000001",
    pidNamespace: "pid:[123]",
  },
  source: { path: `${root}/source`, commit: "b".repeat(40), tree: "c".repeat(40) },
  tools: {
    node: { path: "/private/node", sha256: "d".repeat(64) },
    bun: { path: "/private/bun", sha256: "e".repeat(64) },
    native: { path: `${root}/source/native/tmux`, sha256: "f".repeat(64) },
  },
  instance: { worktree: `${root}/source`, name: `spark-${"a".repeat(32)}`, store: `${root}/store` },
};
test("replacement retires only the daemon, with a fixed managed tuple", () => {
  const down = sparkManagerArgv(descriptor, "down");
  assert(down.includes("--daemon-only"));
  assert.equal(down[down.indexOf("--store") + 1], descriptor.instance.store);
  assert.equal(down[down.indexOf("--name") + 1], descriptor.instance.name);
  assert.equal(down[down.indexOf("--worktree") + 1], descriptor.source.path);
  const rebuild = sparkManagerArgv(descriptor, "rebuild");
  assert.equal(rebuild[rebuild.indexOf("--bun") + 1], descriptor.tools.bun.path);
  assert(!sparkManagerArgv(descriptor, "up").includes("--daemon-only"));
});
test("unknown actions fail before any filesystem or process lookup", async () => {
  await assert.rejects(sparkManagedAction(descriptor, "exec" as never));
});

test("fixed TUI output checks semantic pane and never echoes its visible token", async () => {
  for (const phase of ["baseline", "reconnected", "replaced"] as const) {
    const calls: string[][] = [];
    const result = await sparkTuiOutput(`tui-output-${phase}`, async (args) => {
      calls.push(args);
      return args[0] === "display-message" ? "%17:pane.shared" : "";
    });
    assert.equal(result.emitted, `SPARK_TUI_${phase.toUpperCase()}`);
    assert.equal(calls[0]?.[3], "attribution-collision:0.0");
    assert.equal(calls[1]?.[2], "%17");
    assert(!calls[1]?.[4]?.includes(result.emitted));
    const { execFileSync } = await import("node:child_process");
    assert.equal(
      execFileSync("/bin/sh", ["-c", calls[1]![4]!], { encoding: "utf8" }),
      result.emitted + "\n",
    );
    assert.deepEqual(calls[2], ["send-keys", "-t", "%17", "Enter"]);
  }
});
test("TUI output refuses unknown action or a different semantic pane before sending", async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return "%17:pane.other";
  };
  await assert.rejects(sparkTuiOutput("exec" as never, run));
  assert.equal(calls, 0);
  await assert.rejects(sparkTuiOutput("tui-output-baseline", run));
  assert.equal(calls, 1);
});
