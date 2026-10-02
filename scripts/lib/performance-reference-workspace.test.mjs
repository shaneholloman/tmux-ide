import assert from "node:assert/strict";
import { test } from "node:test";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../../packages/contracts/src/daemon-wire.ts";
import { referenceWorkspaceIntent } from "./performance-reference-workspace.mjs";
const intent = {
  workspaceName: "reference",
  sessionName: "reference",
  availability: "live",
  source: "project",
};
const catalog = {
  version: 2,
  daemon: {
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "test",
    instanceId: "10000000-0000-4000-8000-000000000001",
    startedAt: "2026-09-28T00:00:00Z",
  },
  intents: [intent],
  liveSessions: [],
};
test("uses the current v2 intent for successful readiness evidence without v1 workspaces", () => {
  assert.deepEqual(referenceWorkspaceIntent(catalog, "reference"), intent);
});
test("rejects stale, ambiguous, foreign and obsolete catalog readiness", () => {
  for (const raw of [
    null,
    { ...catalog, version: 1, workspaces: [intent] },
    { ...catalog, intents: [{ ...intent, availability: "stopped" }] },
    { ...catalog, intents: [intent, intent] },
    { ...catalog, intents: [{ ...intent, sessionName: "other" }] },
  ])
    assert.equal(referenceWorkspaceIntent(raw, "reference"), null);
});
