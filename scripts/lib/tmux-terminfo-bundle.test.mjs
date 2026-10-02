import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageTerminfoCatalog } from "./tmux-terminfo-bundle.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "terminfo-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  mkdirSync(input);
  const data = Buffer.alloc(12);
  data.writeUInt16LE(0x021e);
  for (const name of ["xterm-256color", "screen-256color", "tmux-256color"]) {
    mkdirSync(join(input, name[0]), { recursive: true });
    writeFileSync(join(input, name[0], name), data);
  }
  return { root, input, data, output: join(root, "bundle/share/terminfo") };
}
test("materializes internal catalog aliases as regular portable files", (t) => {
  const f = fixture(t);
  symlinkSync("xterm-256color", join(f.input, "x/xterm-alias"));
  const result = stageTerminfoCatalog([f.input], f.output);
  assert.equal(result.entries, 4);
  assert.equal(result.bytes, 48);
  assert(lstatSync(join(f.output, "x/xterm-alias")).isFile());
  assert.deepEqual(readFileSync(join(f.output, "x/xterm-alias")), f.data);
});
test("rejects aliases outside the admitted catalog", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "outside"), f.data);
  symlinkSync("../../outside", join(f.input, "x/xterm-escape"));
  assert.throws(() => stageTerminfoCatalog([f.input], f.output), /escapes/);
});
test("rejects incomplete or uncompiled catalogs", (t) => {
  const f = fixture(t);
  rmSync(join(f.input, "t/tmux-256color"));
  assert.throws(() => stageTerminfoCatalog([f.input], f.output), /Required terminfo/);
  writeFileSync(join(f.input, "t/tmux-256color"), Buffer.alloc(12));
  assert.throws(() => stageTerminfoCatalog([f.input], f.output), /magic/);
});
test("rejects conflicting overlapping package catalogs", (t) => {
  const f = fixture(t);
  const other = join(f.root, "other");
  mkdirSync(join(other, "x"), { recursive: true });
  const different = Buffer.from(f.data);
  different[11] = 1;
  writeFileSync(join(other, "x/xterm-256color"), different);
  assert.throws(() => stageTerminfoCatalog([f.input, other], f.output), /Conflicting/);
});
