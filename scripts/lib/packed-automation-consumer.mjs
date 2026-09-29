// Copied into an external npm consumer. Imports only the installed public SDK.
import { settleAutomationResources } from "./packed-automation-cleanup.mjs";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTmuxIdeAutomationSdk } from "@tmux-ide/sdk";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const resolvedSdk = fileURLToPath(import.meta.resolve("@tmux-ide/sdk"));
assert.ok(resolvedSdk.startsWith(`${realpathSync(config.consumer)}/node_modules/@tmux-ide/sdk/`));
const children = new Map();
const subscriptions = new Set();
let interrupted = false;
const lifetime = new AbortController();
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
function cliProcess(args, input, { raw = false, keepInput = false } = {}) {
  assert.equal(interrupted, false, "Packed consumer interrupted");
  const child = spawn(config.cli, raw ? args : ["automation", ...args, "--json"], {
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
  if (!keepInput) child.stdin.end(input === undefined ? "" : JSON.stringify(input));
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
let cleanupPromise;
function cleanup() {
  return (cleanupPromise ??= settleAutomationResources({ children, subscriptions }));
}
const onSignal = () => {
  interrupted = true;
  lifetime.abort();
  void cleanup().catch(() => {}); // The finalizer awaits and reports this same rejection.
};
process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);
let primaryFailure;
let report;
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
  const sdkPanes = await sdk.discover({ signal: lifetime.signal });
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
  // Exercise every tool through the installed bundled entrypoint. The separate
  // source integration suite retains the full disconnect/cancellation fault matrix.
  const mcp = cliProcess(["mcp"], undefined, { raw: true, keepInput: true });
  let rpcId = 0;
  const rpc = async (method, params) => {
    const id = ++rpcId;
    mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await until(() => {
      const lines = mcp.output().split("\n");
      lines.pop(); // The final transport chunk may be an incomplete JSON frame.
      for (const line of lines) {
        if (!line) continue;
        const frame = JSON.parse(line);
        assert.equal(frame.jsonrpc, "2.0");
        if (frame.id === id) return frame;
      }
      return null;
    }, `installed MCP ${method}`);
    assert.equal(response.error, undefined);
    return response.result;
  };
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "packed-qualification", version: "1" },
  });
  assert.equal(initialized.protocolVersion, "2025-11-25");
  mcp.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const listed = await rpc("tools/list", {});
  const mcpTools = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(mcpTools, [
    "tmux_execute",
    "tmux_interactions",
    "tmux_operation_status",
    "tmux_panes",
    "tmux_prepare",
  ]);
  const mcpPanes = await rpc("tools/call", { name: "tmux_panes", arguments: {} });
  assert.notEqual(mcpPanes.isError, true);
  assert.equal(mcpPanes.content[0].type, "text");
  const mcpDiscovered = JSON.parse(mcpPanes.content[0].text);
  for (const endpoint of [source, target])
    assert.ok(mcpDiscovered.panes.some((pane) => isDeepStrictEqual(pane.endpoint, endpoint)));
  const mcpCall = async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.notEqual(result.isError, true, `Installed MCP ${name} failed`);
    assert.equal(result.content[0]?.type, "text");
    return JSON.parse(result.content[0].text);
  };

  const handles = [];
  const reports = [];
  for (const origin of ["cli", "sdk", "mcp"]) {
    const client =
      origin === "sdk"
        ? {
            reserve: (intent) => sdk.reserve(intent, { signal: lifetime.signal }),
            execute: (handle, intent) => sdk.execute(handle, intent, { signal: lifetime.signal }),
            status: (handle) => sdk.status(handle, { signal: lifetime.signal }),
          }
        : origin === "mcp"
          ? {
              reserve: (intent) => mcpCall("tmux_prepare", { intent }),
              execute: (handle, intent) => mcpCall("tmux_execute", { handle, intent }),
              status: (handle) => mcpCall("tmux_operation_status", { handle }),
            }
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
  assert.equal(new Set(handles.map((handle) => JSON.stringify(handle))).size, 6);
  assert.equal(
    readFileSync(config.targetFile, "utf8"),
    "PACK_PRIVATE_cli\nPACK_PRIVATE_sdk\nPACK_PRIVATE_mcp\n",
  );
  assert.equal(readFileSync(config.sourceFile, "utf8"), "");
  assert.ok(!JSON.stringify(receipts).includes("PACK_PRIVATE_"));
  assert.ok(!JSON.stringify(receipts).includes("PACK_READ_PRIVATE"));
  const mcpReceipts = [];
  let mcpCursor = { server: target.serverScope, cursor: 0 };
  await until(async () => {
    const result = await mcpCall("tmux_interactions", { resume: mcpCursor, waitMs: 100 });
    assert.deepEqual(result.cursor.server, target.serverScope);
    assert.ok(result.cursor.cursor >= mcpCursor.cursor);
    if (result.batch) {
      assert.deepEqual(result.batch.server, target.serverScope);
      assert.equal(result.batch.gap, null);
      assert.equal(result.batch.after, mcpCursor.cursor);
      assert.equal(result.batch.cursor, result.cursor.cursor);
      mcpReceipts.push(...result.batch.receipts);
      assert.ok(mcpReceipts.length <= 4096, "Installed MCP replay exceeded fixture bound");
    }
    mcpCursor = result.cursor;
    return handles.every((handle) =>
      mcpReceipts.some(
        (receipt) => receipt.phase === "observed" && receipt.operationId === handle.operationId,
      ),
    );
  }, "installed MCP scoped receipt replay");
  for (const handle of handles)
    assert.equal(
      mcpReceipts.filter(
        (receipt) => receipt.phase === "observed" && receipt.operationId === handle.operationId,
      ).length,
      1,
    );
  assert.ok(!JSON.stringify(mcpReceipts).includes("PACK_PRIVATE_"));
  assert.ok(!JSON.stringify(mcpReceipts).includes("PACK_READ_PRIVATE"));
  assert.deepEqual(await mcpCall("tmux_interactions", { resume: mcpCursor, waitMs: 100 }), {
    cursor: mcpCursor,
    batch: null,
  });
  await settleAutomationResources({
    children: new Map([[mcp.child, mcp.done]]),
    subscriptions: new Set(),
  });
  assert.equal((await mcp.done).oversized, false);

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
  await settleAutomationResources({
    children: new Map([[events.child, events.done]]),
    subscriptions: new Set(),
  });
  const eventExit = await events.done;
  assert.equal(eventExit.code, 0);
  assert.ok(batches.every((batch) => isDeepStrictEqual(batch.server, target.serverScope)));
  assert.ok(!JSON.stringify(batches).includes("PACK_PRIVATE_"));
  assert.ok(!JSON.stringify(batches).includes("PACK_READ_PRIVATE"));
  await settleAutomationResources({ children: new Map(), subscriptions: new Set([subscription]) });
  report = {
    resolvedSdk,
    source,
    target,
    mcpTools,
    installedMcp: true,
    installedMcpAllTools: true,
    mcpEvents: true,
    operations: reports,
    physicalLines: 3,
    sourcePhysicalLines: 0,
    cliEvents: true,
    sdkEvents: true,
    cursor: subscription.getCursor(),
  };
} catch (error) {
  primaryFailure = error;
}
try {
  await cleanup();
} catch (error) {
  primaryFailure = primaryFailure
    ? new AggregateError(
        [primaryFailure, error],
        "Packed automation failed and cleanup was incomplete",
        { cause: primaryFailure },
      )
    : error;
}
process.off("SIGTERM", onSignal);
process.off("SIGINT", onSignal);
if (primaryFailure) throw primaryFailure;
process.stdout.write(`${JSON.stringify(report)}\n`);
