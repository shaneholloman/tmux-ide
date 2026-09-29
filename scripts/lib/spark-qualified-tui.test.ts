import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  withSparkQualifiedTuiScratch,
  assertSparkQualifiedLibrary,
  assertSparkQualifiedTuiProvenance,
  sparkQualifiedTuiSchema,
} from "./spark-qualified-tui.ts";

const descriptor = {
  version: 1 as const,
  binary: { path: "/private/fixture/tui", sha256: "a".repeat(64) },
  source: { commit: "b".repeat(40), tree: "c".repeat(40), version: "0.1.0" },
  renderer: {
    manifest: "/private/fixture/renderer/manifest.json",
    sha256: "d".repeat(64),
    target: "bun-darwin-arm64" as const,
  },
};
const provenance = {
  version: descriptor.source.version,
  commit: descriptor.source.commit,
  platform: "darwin-arm64",
  sourceState: "clean",
  nativeRenderer: "qualified-native-scroll",
};

test("qualified TUI descriptor admits only closed absolute hash-bound artifacts", () => {
  assert.deepEqual(sparkQualifiedTuiSchema.parse(descriptor), descriptor);
  for (const invalid of [
    { ...descriptor, command: "/bin/sh" },
    { ...descriptor, binary: { ...descriptor.binary, path: "relative/tui" } },
    { ...descriptor, binary: { ...descriptor.binary, path: "/private/../tui" } },
    { ...descriptor, binary: { ...descriptor.binary, sha256: "not-a-hash" } },
    { ...descriptor, source: { ...descriptor.source, tree: "" } },
    { ...descriptor, renderer: { ...descriptor.renderer, target: "bun-linux-arm64" } },
  ])
    assert.throws(() => sparkQualifiedTuiSchema.parse(invalid));
});

test("qualified TUI provenance rejects stock, experimental, dirty and wrong-source binaries", () => {
  assert.deepEqual(assertSparkQualifiedTuiProvenance(provenance, descriptor), provenance);
  for (const [key, value] of [
    ["nativeRenderer", "stock"],
    ["nativeRenderer", "experimental-native-scroll"],
    ["sourceState", "dirty"],
    ["commit", "e".repeat(40)],
    ["version", "0.2.0"],
    ["platform", "linux-arm64"],
  ])
    assert.throws(() =>
      assertSparkQualifiedTuiProvenance({ ...provenance, [key!]: value }, descriptor),
    );
});

test("qualified renderer bytes must occur exactly once in the selected executable", () => {
  const qualified = Buffer.from("qualified-native-renderer-bytes");
  assertSparkQualifiedLibrary(
    Buffer.concat([Buffer.from("binary"), qualified, Buffer.from("end")]),
    qualified,
  );
  assert.throws(() => assertSparkQualifiedLibrary(Buffer.from("stock-renderer-binary"), qualified));
  assert.throws(() =>
    assertSparkQualifiedLibrary(Buffer.concat([qualified, qualified]), qualified),
  );
  assert.throws(() => assertSparkQualifiedLibrary(Buffer.from("binary"), Buffer.alloc(0)));
});

test("rejected provenance removes its entire private scratch tree", async () => {
  let allocated = "";
  await assert.rejects(
    withSparkQualifiedTuiScratch(async (directory) => {
      allocated = directory;
      writeFileSync(join(directory, "partial-library"), "private");
      throw new Error("rejected provenance");
    }),
  );
  assert(allocated);
  assert.equal(existsSync(allocated), false);
});
