import assert from "node:assert/strict";
import { test } from "node:test";
import { createSparkRemoteAction, type SparkRemoteExecOptions } from "./spark-remote-action.ts";
const root = `/tmp/tia-ssh-${"a".repeat(32)}`;
const uuid = "12345678-1234-4321-8000-123456789abc";
const options = {
  root,
  node: "/opt/pinned/node",
  target: "spark-private",
  config: "/tmp/private-ssh-config",
};
function fixture(action = "secondary-start") {
  const calls: { file: string; args: string[]; options: SparkRemoteExecOptions }[] = [];
  const responses: unknown[] = [
    { ok: true, receipt: `receipt-${action}-${uuid}.json` },
    { version: 1, action, result: { privateValue: "kept-private" } },
  ];
  const run = createSparkRemoteAction(options, async (file, args, execOptions) => {
    calls.push({ file, args, options: execOptions });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { stdout: JSON.stringify(response) };
  });
  return { calls, responses, run };
}
test("executes one fixed driver command then privately fetches its exact receipt", async () => {
  const f = fixture();
  assert.deepEqual(await f.run("secondary-start"), { privateValue: "kept-private" });
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.file, "/usr/bin/ssh");
    assert.equal(call.options.killSignal, "SIGKILL");
    assert(call.options.timeout > 0);
    assert(call.args.includes("StrictHostKeyChecking=yes"));
    assert(call.args.includes("ControlPath=none"));
    assert(call.args.includes("ForwardAgent=no"));
    assert.deepEqual(call.args.slice(-2, -1), [options.target]);
  }
  assert.equal(
    f.calls[0]!.args.at(-1),
    `'/usr/bin/env' '-i' 'HOME=${root}' 'PATH=/usr/bin:/bin' '/opt/pinned/node' '${root}/source/scripts/spark-qualification-driver.mjs' '${root}/driver.json' 'secondary-start'`,
  );
  assert(f.calls[1]!.args.at(-1)!.includes("O_NOFOLLOW"));
  assert(f.calls[1]!.args.at(-1)!.endsWith(`'${root}' 'receipt-secondary-start-${uuid}.json'`));
  assert.equal(f.calls[0]!.options.maxBuffer, 8192);
  assert.equal(f.calls[1]!.options.maxBuffer, 1024 * 1024);
});
test("shell metacharacters in pinned paths stay literal", async () => {
  const calls: string[][] = [];
  const run = createSparkRemoteAction(
    { ...options, node: "/opt/a'b$(touch injected)/node", config: "/tmp/config with spaces" },
    async (_file, args) => {
      calls.push(args);
      if (calls.length === 1)
        return {
          stdout: JSON.stringify({ ok: true, receipt: `receipt-secondary-retire-${uuid}.json` }),
        };
      return {
        stdout: JSON.stringify({
          version: 1,
          action: "secondary-retire",
          result: { retired: true },
        }),
      };
    },
  );
  await run("secondary-retire");
  assert(calls[0]!.at(-1)!.includes("'/opt/a'\\''b$(touch injected)/node'"));
  assert.equal(calls[0]![1], "/tmp/config with spaces");
});
test("invalid routing and extra arguments never execute SSH", async () => {
  const f = fixture();
  await assert.rejects(f.run("arbitrary-command"));
  await assert.rejects(f.run("secondary-start", "tmux-server." + "b".repeat(32)));
  await assert.rejects(f.run("secondary-bind-registration"));
  await assert.rejects(f.run("secondary-bind-registration", "-bad"));
  assert.equal(f.calls.length, 0);
  for (const target of ["-oProxyCommand=bad", "host;touch injected", "user@host\n"])
    assert.throws(() => createSparkRemoteAction({ ...options, target }));
  assert.throws(() => createSparkRemoteAction({ ...options, root: root + "/.." }));
});
test("bad envelopes never fetch an arbitrary or other-action receipt", async () => {
  for (const envelope of [
    { ok: true, receipt: "../../private" },
    { ok: true, receipt: `receipt-cleanup-${uuid}.json` },
    { ok: true, receipt: `receipt-secondary-start-${uuid}.json`, extra: true },
    { ok: false, receipt: `receipt-secondary-start-${uuid}.json` },
  ]) {
    const f = fixture();
    f.responses[0] = envelope;
    await assert.rejects(f.run("secondary-start"), /unconfirmed/);
    assert.equal(f.calls.length, 1);
  }
});
test("uncertain command and receipt outcomes are sanitized and never retried", async () => {
  for (const stage of [0, 1]) {
    const f = fixture();
    f.responses[stage] = new Error("PRIVATE TOKEN stdout stderr");
    await assert.rejects(
      f.run("secondary-start"),
      (error: Error) => !error.message.includes("PRIVATE TOKEN") && !error.cause,
    );
    assert.equal(f.calls.length, stage + 1);
  }
  for (const receipt of [
    { version: 2, action: "secondary-start", result: {} },
    { version: 1, action: "cleanup", result: {} },
    { version: 1, action: "secondary-start" },
    { version: 1, action: "secondary-start", result: {}, extra: true },
  ]) {
    const f = fixture();
    f.responses[1] = receipt;
    await assert.rejects(f.run("secondary-start"), /unconfirmed/);
    assert.equal(f.calls.length, 2);
  }
});
test("registration is the sole action accepting a server ID", async () => {
  const f = fixture("secondary-bind-registration");
  const id = `tmux-server.${"b".repeat(32)}`;
  await f.run("secondary-bind-registration", id);
  assert(f.calls[0]!.args.at(-1)!.endsWith(`'secondary-bind-registration' '${id}'`));
});
