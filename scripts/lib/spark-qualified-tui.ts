/** Qualification-only admission of a separately compiled, release-qualified TUI. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import {
  developmentFileHash,
  type DevelopmentBuildManifest,
} from "../../packages/daemon/src/lib/development-build.ts";
import { readPrivateDevelopmentRecord } from "../../packages/daemon/src/lib/development-state.ts";
import { validateNativeScrollReleaseManifest } from "./native-scroll-release-manifest.mjs";

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      isAbsolute(value) &&
      normalize(value) === value &&
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
export const sparkQualifiedTuiSchema = z
  .object({
    version: z.literal(1),
    binary: z.object({ path: absolute, sha256 }).strict(),
    source: z.object({ commit, tree: commit, version: z.string().min(1).max(128) }).strict(),
    renderer: z
      .object({
        manifest: absolute,
        sha256,
        target: z.literal("bun-darwin-arm64"),
      })
      .strict(),
  })
  .strict();

export function assertSparkQualifiedTuiProvenance(
  value: unknown,
  descriptor: z.infer<typeof sparkQualifiedTuiSchema>,
) {
  const provenance = z
    .object({
      version: z.literal(descriptor.source.version),
      commit: z.literal(descriptor.source.commit),
      platform: z.literal("darwin-arm64"),
      sourceState: z.literal("clean"),
      nativeRenderer: z.literal("qualified-native-scroll"),
    })
    .strict()
    .parse(value);
  return provenance;
}

export function assertSparkQualifiedLibrary(binary: Buffer, library: Buffer) {
  assert(library.length > 0, "Qualified renderer library is empty");
  const first = binary.indexOf(library);
  assert(first >= 0, "Qualified renderer library is absent from TUI");
  assert.equal(binary.indexOf(library, first + 1), -1, "Qualified renderer library is duplicated");
}

export async function withSparkQualifiedTuiScratch<T>(
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), "spark-qualified-tui-"));
  try {
    return await work(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function ownedFile(path: string, executable = false) {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && realpathSync(path) === path);
  assert(stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0);
  if (executable) assert((stat.mode & 0o100) !== 0);
}

export async function admitSparkQualifiedTui(options: {
  descriptor: string;
  repository: string;
  build: DevelopmentBuildManifest;
  signal: AbortSignal;
}) {
  assert(process.platform === "darwin" && process.arch === "arm64");
  const descriptor = sparkQualifiedTuiSchema.parse(
    readPrivateDevelopmentRecord(options.descriptor),
  );
  const { build, repository, signal } = options;
  assert.equal(descriptor.source.commit, build.source.commit);
  assert.equal(descriptor.source.version, build.packageVersion);
  assert.equal(build.source.dirty, false);
  const run = async (file: string, args: string[], scratch?: string) => {
    const result = await promisify(execFile)(file, args, {
      cwd: repository,
      env: {
        HOME: dirname(descriptor.binary.path),
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        ...(scratch ? { TMPDIR: scratch, HOME: scratch } : {}),
      },
      signal,
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    return result.stdout.trim();
  };
  assert.equal(await run("/usr/bin/git", ["rev-parse", "HEAD"]), descriptor.source.commit);
  assert.equal(await run("/usr/bin/git", ["rev-parse", "HEAD^{tree}"]), descriptor.source.tree);
  assert.equal(await run("/usr/bin/git", ["status", "--porcelain", "--untracked-files=all"]), "");
  ownedFile(descriptor.renderer.manifest);
  assert.equal(developmentFileHash(descriptor.renderer.manifest), descriptor.renderer.sha256);
  const packageJson = JSON.parse(
    readFileSync(join(repository, "node_modules/@opentui/core/package.json"), "utf8"),
  );
  const renderer = validateNativeScrollReleaseManifest(descriptor.renderer.manifest, {
    repository,
    target: descriptor.renderer.target,
    sourceState: "clean",
    coreVersion: packageJson.version,
  });
  const revalidate = () => {
    ownedFile(descriptor.binary.path, true);
    assert.equal(developmentFileHash(descriptor.binary.path), descriptor.binary.sha256);
  };
  revalidate();
  assertSparkQualifiedLibrary(readFileSync(descriptor.binary.path), readFileSync(renderer.library));
  await run("/usr/bin/codesign", ["--verify", "--strict", descriptor.binary.path]);
  const provenance = await withSparkQualifiedTuiScratch(async (scratch) =>
    assertSparkQualifiedTuiProvenance(
      JSON.parse(await run(descriptor.binary.path, ["__release-provenance"], scratch)),
      descriptor,
    ),
  );
  revalidate();
  return { binary: descriptor.binary.path, descriptor, provenance, revalidate };
}
