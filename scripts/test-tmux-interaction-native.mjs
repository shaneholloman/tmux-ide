#!/usr/bin/env node
/** Native journal qualification uses only an owned scratch source tree/socket. */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTmuxNativePatches } from "./lib/tmux-native-patches.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const at = process.argv.indexOf("--source");
if (at < 0 || !process.argv[at + 1]) throw new Error("Pass --source pinned tmux checkout");
const source = resolve(process.argv[at + 1]);
const evidenceAt = process.argv.indexOf("--evidence-dir");
const evidence = evidenceAt < 0 ? null : process.argv[evidenceAt + 1];
if (evidenceAt >= 0) {
  if (!evidence || !isAbsolute(evidence)) throw new Error("Absolute --evidence-dir required");
  // Exclusive private directory; never overwrite an earlier campaign's evidence.
  mkdirSync(evidence, { mode: 0o700 });
  const info = lstatSync(evidence);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700
  )
    throw new Error("Unsafe native evidence directory");
}
const provenance = JSON.parse(readFileSync(join(root, "native/tmux/provenance.json"), "utf8"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("GIT_") &&
      !["LD_LIBRARY_PATH", "LD_PRELOAD", "CFLAGS", "CPPFLAGS", "LDFLAGS"].includes(key),
  ),
);
// Only an explicitly admitted destination reaches the child fixtures.
delete env.TMUX_IDE_NATIVE_TEST_EVIDENCE_DIR;
if (evidence) env.TMUX_IDE_NATIVE_TEST_EVIDENCE_DIR = evidence;
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
  run(
    "cc",
    [
      "-std=c11",
      "-g",
      "-fsanitize=address,undefined",
      "-fno-omit-frame-pointer",
      `-I${scratch}`,
      join(root, "native/tmux/tests/snapshot-buffer.c"),
      "-o",
      join(scratch, "snapshot-buffer"),
    ],
    scratch,
  );
  run(join(scratch, "snapshot-buffer"), [], scratch);
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
  run(
    "python3",
    [join(root, "native/tmux/tests/journal-operation-identity.py"), join(scratch, "tmux")],
    scratch,
  );
  run(
    "python3",
    [join(root, "native/tmux/tests/journal-pane-guard.py"), join(scratch, "tmux")],
    scratch,
  );
  run(
    "python3",
    [join(root, "native/tmux/tests/journal-session-guard.py"), join(scratch, "tmux")],
    scratch,
  );
  run(
    "python3",
    [join(root, "native/tmux/tests/atomic-snapshot.py"), join(scratch, "tmux")],
    scratch,
  );
} catch (error) {
  if (evidence) {
    try {
      const files = [];
      for (const name of ["journal-ring", "snapshot-buffer", "tmux"]) {
        const path = join(scratch, name);
        if (!existsSync(path)) continue;
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024)
          throw new Error("Unsafe sanitizer diagnostic executable", { cause: error });
        copyFileSync(path, join(evidence, name));
        files.push({ name, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
      }
      let symbols = null;
      if (process.platform === "darwin" && files.length > 0) {
        // Darwin debug maps reference scratch .o files; symbolize before deleting them.
        const name = files.at(-1).name;
        try {
          const output = execFileSync(
            "/usr/bin/dsymutil",
            [join(scratch, name), "-o", join(evidence, `${name}.dSYM`)],
            {
              env,
              timeout: 30000,
              killSignal: "SIGKILL",
              maxBuffer: 1024 * 1024,
              encoding: "utf8",
            },
          );
          writeFileSync(join(evidence, "dsymutil.log"), output, { flag: "wx", mode: 0o600 });
          symbols = { executable: name, status: "created" };
        } catch (diagnosticError) {
          const output = [diagnosticError.stdout, diagnosticError.stderr]
            .map((value) => (typeof value === "string" ? value.slice(0, 1024 * 1024) : ""))
            .join("\n");
          writeFileSync(join(evidence, "dsymutil.log"), output, { flag: "wx", mode: 0o600 });
          symbols = {
            executable: name,
            status: "failed",
            timedOut: diagnosticError.signal === "SIGKILL",
          };
        }
      }
      writeFileSync(
        join(evidence, "failed-build.json"),
        JSON.stringify({ upstream: actual, files, symbols }),
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      process.stderr.write(
        "Native failed-build diagnostic export failed; original failure preserved\n",
      );
    }
  }
  throw error;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
