#!/usr/bin/env node
/** Native journal qualification uses only an owned scratch source tree/socket. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTmuxNativePatches } from "./lib/tmux-native-patches.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const at = process.argv.indexOf("--source");
if (at < 0 || !process.argv[at + 1]) throw new Error("Pass --source pinned tmux checkout");
const source = resolve(process.argv[at + 1]);
const provenance = JSON.parse(readFileSync(join(root, "native/tmux/provenance.json"), "utf8"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("GIT_") &&
      !["LD_LIBRARY_PATH", "LD_PRELOAD", "CFLAGS", "CPPFLAGS", "LDFLAGS"].includes(key),
  ),
);
const run = (command, args, cwd, extra = {}) =>
  execFileSync(command, args, { cwd, env, stdio: "inherit", ...extra });
const actual = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  env,
  encoding: "utf8",
}).trim();
if (actual !== provenance.commit) throw new Error("Pinned tmux source mismatch");
const patches = readTmuxNativePatches(provenance, join(root, "native/tmux"));
const scratch = mkdtempSync(join(tmpdir(), "tmux-ide-journal-build-"));
try {
  const archive = execFileSync("git", ["-C", source, "archive", provenance.commit], {
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  run("tar", ["-xf", "-", "-C", scratch], root, {
    input: archive,
    stdio: ["pipe", "inherit", "inherit"],
  });
  for (const patch of patches)
    run("git", ["apply", "-"], scratch, {
      input: patch.bytes,
      stdio: ["pipe", "inherit", "inherit"],
    });
  run(
    "cc",
    [
      "-std=c11",
      "-g",
      "-fsanitize=address,undefined",
      "-fno-omit-frame-pointer",
      `-I${scratch}`,
      join(root, "native/tmux/tests/journal-ring.c"),
      "-o",
      join(scratch, "journal-ring"),
    ],
    scratch,
  );
  run(join(scratch, "journal-ring"), [], scratch);
  run("sh", ["autogen.sh"], scratch);
  run(
    "./configure",
    [
      "--enable-utf8proc",
      "--disable-jemalloc",
      "CFLAGS=-g -O1 -DTMUX_IDE_JOURNAL_TEST -fsanitize=address,undefined -fno-omit-frame-pointer",
      "LDFLAGS=-fsanitize=address,undefined",
    ],
    scratch,
  );
  run("make", ["-j4"], scratch);
  run("python3", [join(root, "native/tmux/tests/journal-live.py"), join(scratch, "tmux")], scratch);
  run(
    "python3",
    [join(root, "native/tmux/tests/journal-commands.py"), join(scratch, "tmux")],
    scratch,
  );
  run(
    "python3",
    [join(root, "native/tmux/tests/journal-exhaustion.py"), join(scratch, "tmux")],
    scratch,
  );
  run(
    "python3",
    [join(root, "native/tmux/tests/journal-effects.py"), join(scratch, "tmux")],
    scratch,
  );
  run(
    "python3",
    [join(root, "native/tmux/tests/journal-correlation.py"), join(scratch, "tmux")],
    scratch,
  );
  run(
    "python3",
    [join(root, "native/tmux/tests/journal-pane-identity.py"), join(scratch, "tmux")],
    scratch,
  );
  run("python3", [join(root, "native/tmux/tests/journal-park.py"), join(scratch, "tmux")], scratch);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
