import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTmuxNativePatches } from "./tmux-native-patches.mjs";

test("validates ordered patch closure and retains legacy primary compatibility", () => {
  const dir = mkdtempSync(join(tmpdir(), "tmux-native-patches-"));
  try {
    const entries = ["grid", "interaction"].map((name) => {
      const bytes = Buffer.from(name);
      writeFileSync(join(dir, `${name}.patch`), bytes);
      return {
        patch: `${name}.patch`,
        patchSha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    const legacy = { schemaVersion: 1, ...entries[0] };
    assert.equal(readTmuxNativePatches(legacy, dir).length, 1);
    assert.deepEqual(
      readTmuxNativePatches({ ...legacy, patches: entries }, dir).map((x) => x.bytes.toString()),
      ["grid", "interaction"],
    );
    for (const patches of [
      [],
      [entries[1]],
      [entries[0], entries[0]],
      [entries[0], { ...entries[1], patch: "../escape.patch" }],
      [entries[0], { ...entries[1], patchSha256: "0".repeat(64) }],
    ])
      assert.throws(() => readTmuxNativePatches({ ...legacy, patches }, dir));
    assert.throws(() => readTmuxNativePatches({ ...legacy, schemaVersion: 9 }, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
