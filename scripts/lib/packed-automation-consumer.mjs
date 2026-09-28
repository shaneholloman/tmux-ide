// Copied into an external npm consumer. Imports only the installed public SDK.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTmuxIdeAutomationSdk } from "@tmux-ide/sdk";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const resolvedSdk = fileURLToPath(import.meta.resolve("@tmux-ide/sdk"));
assert.ok(resolvedSdk.startsWith(`${config.consumer}/node_modules/@tmux-ide/sdk/`));
const children = new Map();
const subscriptions = new Set();
let interrupted = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, ms = 15000) {
  const end = Date.now() + ms;
  while (!interrupted && Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function cliProcess(args, input) {
  assert.equal(interrupted, false, "Packed consumer interrupted");
  const child = spawn(config.cli, ["automation", ...args, "--json"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    oversized = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) {
      oversized = true;
      child.kill();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > 128 * 1024) {
      oversized = true;
      child.kill();
    }
  });
  const done = new Promise((resolve) => {
    child.once("error", () => {
      oversized = true;
    });
    child.once("close", (code, signal) => resolve({ code, signal, oversized, stdout, stderr }));
  });
  children.set(child, done);
  child.stdin.on("error", () => {});
  child.stdin.end(input === undefined ? "" : JSON.stringify(input));
  return { child, done, output: () => stdout };
}
async function cli(args, input) {
  const call = cliProcess(args, input);
  let force;
  const timer = setTimeout(() => {
    call.child.kill("SIGTERM");
    force = setTimeout(() => call.child.kill("SIGKILL"), 1000);
  }, 20000);
  try {
    const result = await call.done;
    assert.equal(result.oversized, false);
    // Deliberately do not print captured text or private credentials on failure.
    assert.equal(result.code, 0, `Installed CLI ${args[0]} failed`);
    return JSON.parse(result.stdout);
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
  }
}
async function cleanup() {
  for (const subscription of subscriptions) subscription.close();
  await Promise.allSettled([...subscriptions].map((subscription) => subscription.done));
  for (const child of children.keys())
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const all = Promise.all([...children.values()]);
  await Promise.race([all, delay(1000)]);
  for (const child of children.keys())
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await all;
}
const onSignal = () => {
  interrupted = true;
  void cleanup();
};
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
try {
  const found = await until(async () => {
    const result = await cli(["panes"]);
    const panes = result.panes.filter((pane) => pane.sessionName === config.session);
    return panes.length === 2 ? panes : null;
  }, "installed CLI discovery");
  const target = found.find(
    (pane) => pane.endpoint.semanticPaneId === "pane.pack-target",
  )?.endpoint;
  const source = found.find(
    (pane) => pane.endpoint.semanticPaneId === "pane.pack-source",
  )?.endpoint;
  assert.ok(target && source);
  assert.deepEqual(target.serverScope, source.serverScope);
  // Reconciliation happens through actual daemon discovery, not fixture-issued credentials.
  const credential = await until(() => {
    let text;
    try {
      text = execFileSync(
        "tmux",
        [
          "-S",
          config.socket,
          "show-options",
          "-p",
          "-v",
          "-t",
          config.sourcePane,
          "@tmux_ide_source_credential_v1",
        ],
        { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      return null;
    }
    return text || null;
  }, "source credential");
  const sdk = createTmuxIdeAutomationSdk({
    baseUrl: config.baseUrl,
    ownerToken: config.ownerToken,
    sourceCredential: credential,
  });
  const sdkPanes = await sdk.discover();
  assert.ok(sdkPanes.panes.some((pane) => isDeepStrictEqual(pane.endpoint, target)));
  const receipts = [];
  const subscription = sdk.subscribe({
    server: target.serverScope,
    onBatch: (batch) => {
      assert.deepEqual(batch.server, target.serverScope);
      receipts.push(...batch.receipts);
    },
  });
  subscriptions.add(subscription);
  await subscription.ready;
  const handles = [];
  const reports = [];
  for (const origin of ["cli", "sdk"]) {
    const client =
      origin === "sdk"
        ? sdk
        : {
            reserve: (intent) => cli(["reserve"], intent),
            execute: (handle, intent) => cli(["execute"], { version: 1, handle, intent }),
            status: (handle) => cli(["status", handle.generation, handle.operationId]),
          };
    const text = `PACK_PRIVATE_${origin}`;
    const intent = { kind: "send", target, source, text, enter: true };
    const { handle } = await client.reserve(intent);
    handles.push(handle);
    assert.deepEqual((await client.execute(handle, intent)).handle, handle);
    assert.deepEqual((await client.execute(handle, intent)).handle, handle);
    const status = await client.status(handle);
    assert.equal(status.status, "completed");
    assert.ok(!JSON.stringify(status).includes(text));
    await until(
      () =>
        readFileSync(config.targetFile, "utf8")
          .split("\n")
          .filter((line) => line === text).length === 1,
      "physical single delivery",
    );
    const readIntent = { kind: "read", target, source };
    const readHandle = (await client.reserve(readIntent)).handle;
    handles.push(readHandle);
    const first = await client.execute(readHandle, readIntent);
    assert.equal(first.read?.availability, "available");
    assert.ok(first.read.text.includes("PACK_READ_PRIVATE"));
    const replay = await client.execute(readHandle, readIntent);
    assert.deepEqual(replay.read, { availability: "replay-unavailable", text: null });
    for (const expectedHandle of [handle, readHandle]) {
      const observed = await until(
        () =>
          receipts.find(
            (receipt) =>
              receipt.type === "interaction.receipt" &&
              receipt.phase === "observed" &&
              receipt.operationId === expectedHandle.operationId,
          ),
        "observed receipt",
      );
      assert.equal(observed.origin, origin);
      assert.equal(observed.evidence.actor.kind, "cooperative");
      assert.deepEqual(observed.evidence.endpoints, { source, destination: target });
      assert.equal(
        receipts.filter(
          (receipt) =>
            receipt.phase === "observed" && receipt.operationId === expectedHandle.operationId,
        ).length,
        1,
      );
    }
    reports.push({ origin, send: handle, read: readHandle, readReplay: replay.read.availability });
  }
  assert.equal(new Set(handles.map((handle) => JSON.stringify(handle))).size, 4);
  assert.equal(readFileSync(config.targetFile, "utf8"), "PACK_PRIVATE_cli\nPACK_PRIVATE_sdk\n");
  assert.equal(readFileSync(config.sourceFile, "utf8"), "");
  assert.ok(!JSON.stringify(receipts).includes("PACK_PRIVATE_"));
  assert.ok(!JSON.stringify(receipts).includes("PACK_READ_PRIVATE"));
  const events = cliProcess(["events"], { server: target.serverScope, cursor: 0 });
  const batches = await until(() => {
    const lines = events.output().split("\n").filter(Boolean);
    try {
      const parsed = lines.map((line) => JSON.parse(line));
      return handles.every((handle) =>
        parsed.some((batch) =>
          batch.receipts.some(
            (receipt) => receipt.phase === "observed" && receipt.operationId === handle.operationId,
          ),
        ),
      )
        ? parsed
        : null;
    } catch {
      return null;
    }
  }, "installed CLI scoped event stream");
  events.child.kill("SIGTERM");
  const eventExit = await events.done;
  assert.equal(eventExit.code, 0);
  assert.ok(batches.every((batch) => isDeepStrictEqual(batch.server, target.serverScope)));
  assert.ok(!JSON.stringify(batches).includes("PACK_PRIVATE_"));
  assert.ok(!JSON.stringify(batches).includes("PACK_READ_PRIVATE"));
  subscription.close();
  await subscription.done;
  process.stdout.write(
    `${JSON.stringify({ resolvedSdk, source, target, operations: reports, physicalLines: 2, sourcePhysicalLines: 0, cliEvents: true, sdkEvents: true, cursor: subscription.getCursor() })}\n`,
  );
} finally {
  await cleanup();
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
}
