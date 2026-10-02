import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSparkQualificationDescriptor as validate } from "./spark-qualification-descriptor.mjs";
const instance = { worktree: "/private/tree", name: "spark", store: "/private/store" };
const lease = {
  version: 1,
  instanceId: `dev-${"a".repeat(24)}`,
  ...instance,
  daemonId: "10000000-0000-4000-8000-000000000001",
  pid: 123,
  port: 34567,
  startedAt: "2026-09-28T00:00:00Z",
  protocolVersion: 1,
  productVersion: "2.9.0-beta.45",
  generation: "build-10000000-0000-4000-8000-000000000002",
  manifestHash: "b".repeat(64),
};
test("validates complete tuple/lease independent of property order", () => {
  const descriptor = {
    version: 1,
    instance,
    expected: Object.fromEntries(Object.entries(lease).reverse()),
  };
  assert.equal(validate(descriptor), descriptor);
});
test("refuses malformed descriptor structure before any owner lookup", () => {
  const valid = { version: 1, instance, expected: lease };
  for (const bad of [
    null,
    { ...valid, instance: null },
    { ...valid, expected: null },
    { ...valid, expected: [] },
    { ...valid, instance: { ...instance, userHome: "/other" } },
    { ...valid, unexpected: true },
    { ...valid, instance: { ...instance, store: "relative" } },
    { ...valid, instance: { ...instance, name: "bad/name" } },
    { ...valid, instance: { ...instance, worktree: "/private/\0bad" } },
  ])
    assert.throws(() => validate(bad), /descriptor shape refused/u);
});
