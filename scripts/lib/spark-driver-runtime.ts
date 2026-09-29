/** Read-only preflight shared by every private Spark lifecycle action. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { developmentFileHash } from "../../packages/daemon/src/lib/development-build.ts";
import { sparkExecutionIdentity, type SparkExecutionIdentity } from "./spark-process-witness.ts";

type Tool = { path: string; sha256: string };
export interface SparkDriverRuntimeDescriptor {
  root: string;
  execution: SparkExecutionIdentity;
  source: { path: string; commit: string; tree: string };
  tools: { node: Tool; bun: Tool; native: Tool };
}

export function verifySparkTool(tool: Tool): void {
  const before = lstatSync(tool.path);
  assert(before.isFile() && (before.mode & 0o111) !== 0, "Qualification tool is not executable");
  assert.equal(realpathSync(tool.path), tool.path, "Qualification tool path changed");
  assert.equal(developmentFileHash(tool.path), tool.sha256, "Qualification tool digest changed");
  const after = lstatSync(tool.path);
  for (const key of ["dev", "ino", "size", "mode", "uid", "mtimeMs", "ctimeMs"] as const)
    assert.equal(
      before[key],
      after[key],
      "Qualification tool identity changed during verification",
    );
}

/** No inherited tmux authority, node loader, git config, or library injection. */
export function sparkDriverEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    HOME: root,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function verifySparkSource(
  source: SparkDriverRuntimeDescriptor["source"],
  root: string,
) {
  assert.equal(realpathSync(source.path), source.path);
  const execute = promisify(execFile);
  const git = async (args: string[]) =>
    (
      await execute(
        "/usr/bin/git",
        ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
        {
          cwd: source.path,
          env: sparkDriverEnvironment(root),
          encoding: "utf8",
          timeout: 10000,
          killSignal: "SIGKILL",
          maxBuffer: 65536,
        },
      )
    ).stdout.trim();
  assert.equal(await git(["rev-parse", "--show-toplevel"]), source.path);
  const localConfig = await git(["config", "--local", "--list", "--null"]);
  assert(
    !localConfig.split("\0").some((entry) => /^filter\./iu.test(entry)),
    "Repository filters are not allowed in qualification source",
  );
  const indexFlags = await git(["ls-files", "-v", "-z"]);
  assert(
    indexFlags
      .split("\0")
      .filter(Boolean)
      .every((entry) => entry.startsWith("H ")),
    "Hidden index entries are not allowed in qualification source",
  );
  assert.equal(
    await git(["rev-parse", "HEAD"]),
    source.commit,
    "Qualification source commit changed",
  );
  assert.equal(
    await git(["rev-parse", "HEAD^{tree}"]),
    source.tree,
    "Qualification source tree changed",
  );
  assert.equal(
    await git(["status", "--porcelain", "--untracked-files=normal"]),
    "",
    "Qualification source is dirty",
  );
}

export async function verifySparkDriverRuntime(descriptor: SparkDriverRuntimeDescriptor) {
  assert.deepEqual(sparkExecutionIdentity(), descriptor.execution);
  assert.equal(realpathSync(process.execPath), descriptor.tools.node.path);
  for (const tool of Object.values(descriptor.tools)) verifySparkTool(tool);
  await verifySparkSource(descriptor.source, descriptor.root);
  assert.deepEqual(sparkExecutionIdentity(), descriptor.execution);
}
