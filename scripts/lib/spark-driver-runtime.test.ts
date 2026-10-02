import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  verifySparkTool,
  verifySparkSource,
  sparkDriverEnvironment,
} from "./spark-driver-runtime.ts";

test("runtime refuses changed, nonexecutable, or redirected tool bytes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spark-tool-")));
  try {
    const path = join(root, "tool"),
      bytes = "#!/bin/sh\nexit 0\n";
    writeFileSync(path, bytes, { mode: 0o700 });
    const tool = { path, sha256: createHash("sha256").update(bytes).digest("hex") };
    verifySparkTool(tool);
    writeFileSync(path, "#!/bin/sh\nexit 1\n");
    assert.throws(() => verifySparkTool(tool), /digest changed/);
    writeFileSync(path, bytes);
    chmodSync(path, 0o600);
    assert.throws(() => verifySparkTool(tool), /not executable/);
    chmodSync(path, 0o700);
    symlinkSync(path, join(root, "link"));
    assert.throws(() => verifySparkTool({ ...tool, path: join(root, "link") }));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("source proof rejects a dirty tree, untracked source, or a different commit", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spark-source-")));
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: root,
      env: sparkDriverEnvironment(root),
      encoding: "utf8",
    }).trim();
  try {
    git("init", "-q");
    writeFileSync(join(root, "fixture"), "original\n");
    git("add", "fixture");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    );
    const source = {
      path: root,
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
    };
    await verifySparkSource(source, root);
    await assert.rejects(
      verifySparkSource({ ...source, commit: "a".repeat(40) }, root),
      /commit changed/,
    );
    git("update-index", "--assume-unchanged", "fixture");
    writeFileSync(join(root, "fixture"), "hidden\n");
    await assert.rejects(verifySparkSource(source, root), /Hidden index/);
    git("update-index", "--no-assume-unchanged", "fixture");
    git("config", "filter.hostile.clean", "exit 1");
    await assert.rejects(verifySparkSource(source, root), /filters/);
    git("config", "--remove-section", "filter.hostile");
    writeFileSync(join(root, "fixture"), "changed\n");
    await assert.rejects(verifySparkSource(source, root), /dirty/);
    writeFileSync(join(root, "fixture"), "original\n");
    writeFileSync(join(root, "untracked.ts"), "export {};\n");
    await assert.rejects(verifySparkSource(source, root), /dirty/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
