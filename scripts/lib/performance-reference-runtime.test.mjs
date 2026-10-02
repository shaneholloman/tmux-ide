import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Bun pane-stream preflight resolves its own workspace imports before requiring a target", () => {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("TMUX_IDE_REFERENCE_") || key === "NODE_PATH" || key === "NODE_OPTIONS")
      delete env[key];
  const result = spawnSync(
    "bun",
    [fileURLToPath(new URL("../performance-reference-pane-stream.ts", import.meta.url))],
    { env, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TMUX_IDE_REFERENCE_WORKSPACE is required/u);
  assert.doesNotMatch(result.stderr, /Cannot find module/u);
});

test("Bun ProductTestRig multi-client subprocess resolves its owning source dependencies", () => {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("TMUX_IDE_RIG_") || key === "NODE_PATH" || key === "NODE_OPTIONS")
      delete env[key];
  const result = spawnSync(
    "bun",
    [fileURLToPath(new URL("../product-test-rig-multiclient.ts", import.meta.url))],
    { env, encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TMUX_IDE_RIG_BASE_URL is required/u);
  assert.doesNotMatch(result.stderr, /Cannot find module/u);
});
