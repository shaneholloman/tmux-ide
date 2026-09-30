import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
import { readDevelopmentBuild } from "./development-build.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Validate a complete platform bundle before selecting it as daemon authority. */
export function validateBundledTmux(
  directory: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const root = realpathSync(directory);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    // Both known distributions remain usable; the live server capture probe
    // decides bootstrap capability, independently of the installed client.
    (manifest.extension !== "tmux-ide-native-grid-v1" &&
      manifest.extension !== "tmux-ide-native-grid-v2") ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    typeof manifest.files.tmux !== "string"
  )
    throw new Error("Invalid bundled tmux manifest");
  if (platform === "darwin") parseMacOSVersion(manifest.minimumMacOS);
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (isAbsolute(name) || name.split(/[\\/]/u).includes(".."))
      throw new Error("Invalid bundled tmux file path");
    const path = realpathSync(join(root, name));
    const local = relative(root, path);
    if (local.startsWith(`..${sep}`) || local === ".." || isAbsolute(local))
      throw new Error("Bundled tmux file escapes its distribution");
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== expected) throw new Error(`Bundled tmux checksum mismatch: ${name}`);
  }
  if (manifest.terminfo !== undefined) {
    const catalog = manifest.terminfo;
    const entries = Object.keys(manifest.files).filter((name) =>
      name.startsWith("share/terminfo/"),
    );
    if (
      catalog.directory !== "share/terminfo" ||
      !Number.isSafeInteger(catalog.entries) ||
      catalog.entries < 1 ||
      catalog.entries > 8192 ||
      entries.length !== catalog.entries ||
      entries.some(
        (name) =>
          !/^share\/terminfo\/(?:[A-Za-z0-9]|[0-9a-fA-F]{2})\/[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}$/u.test(
            name,
          ),
      ) ||
      !["xterm-256color", "screen-256color", "tmux-256color"].every((name) =>
        entries.some((entry) => entry.endsWith(`/${name}`)),
      )
    ) {
      throw new Error("Invalid bundled terminfo catalog");
    }
    const directory = join(root, "share/terminfo");
    const actual: string[] = [];
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
      throw new Error("Invalid bundled terminfo directory");
    for (const bucket of readdirSync(directory)) {
      const bucketPath = join(directory, bucket),
        bucketStat = lstatSync(bucketPath);
      if (!bucketStat.isDirectory() || bucketStat.isSymbolicLink())
        throw new Error("Invalid bundled terminfo bucket");
      for (const name of readdirSync(bucketPath)) {
        const entry = lstatSync(join(bucketPath, name));
        if (!entry.isFile() || entry.isSymbolicLink())
          throw new Error("Invalid bundled terminfo entry");
        actual.push(`share/terminfo/${bucket}/${name}`);
      }
    }
    if (actual.sort().join("\n") !== entries.sort().join("\n"))
      throw new Error("Unlisted bundled terminfo entry");
  }
  const executable = realpathSync(join(root, "tmux"));
  // npm normalizes non-bin payloads to 0644. Restore execution only after the
  // complete bundle has passed integrity checks (also supports --ignore-scripts).
  try {
    accessSync(executable, constants.X_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    chmodSync(executable, 0o755);
  }
  accessSync(executable, constants.X_OK);
  return executable;
}

/** Locate installed assets from source, the Node bundle, or the CLI-forwarded Bun host. */
export function resolveBundledTmux(
  anchors: readonly string[] = [
    ...(process.env.TMUX_IDE_CLI ? [process.env.TMUX_IDE_CLI] : []),
    fileURLToPath(import.meta.url),
  ],
  currentMacOSVersion: () => string = () =>
    execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
): string | null {
  const namespace = resolveRuntimeNamespace();
  if (namespace.development) {
    const build = readDevelopmentBuild(namespace.development);
    const bundle = join(build.assets, "tmux", `${process.platform}-${process.arch}`);
    if (!existsSync(join(bundle, "manifest.json")))
      throw new Error("Development build lacks bundled tmux; rebuild with qualified native assets");
    const executable = validateBundledTmux(bundle);
    if (process.platform === "darwin") {
      const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
      if (!isMacOSVersionCompatible(currentMacOSVersion(), manifest.minimumMacOS))
        throw new Error("Development bundled tmux is incompatible with this OS");
    }
    return executable;
  }
  const visited = new Set<string>();
  for (const anchor of anchors) {
    if (!isAbsolute(anchor)) continue;
    let directory = dirname(resolve(anchor));
    while (!visited.has(directory)) {
      visited.add(directory);
      const bundle = join(
        directory,
        "packages/daemon/dist/native/tmux",
        `${process.platform}-${process.arch}`,
      );
      if (existsSync(join(bundle, "manifest.json"))) {
        const executable = validateBundledTmux(bundle);
        if (process.platform === "darwin") {
          const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
          if (!isMacOSVersionCompatible(currentMacOSVersion(), manifest.minimumMacOS)) return null;
        }
        return executable;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return null;
}

function parseMacOSVersion(value: unknown): readonly number[] {
  if (typeof value !== "string" || !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/u.test(value))
    throw new Error("Invalid bundled tmux macOS version metadata");
  return value.split(".").map(Number);
}

/** Compare numeric OS components, including old 10.x and patch-level floors. */
export function isMacOSVersionCompatible(current: string, minimum: string): boolean {
  const actual = parseMacOSVersion(current);
  const required = parseMacOSVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

const resourceEnvironments = new Map<
  string,
  { identity: string; environment: Readonly<NodeJS.ProcessEnv> }
>();
/** Data authority follows the selected executable. Legacy/external tmux keeps its existing behavior. */
export function bundledTmuxResourceEnvironment(
  executable: string | undefined,
): Readonly<NodeJS.ProcessEnv> {
  if (!executable || !isAbsolute(executable) || !existsSync(executable)) return {};
  const canonical = realpathSync(executable);
  const root = dirname(canonical),
    manifestPath = join(root, "manifest.json");
  if (canonical !== join(root, "tmux") || !existsSync(manifestPath)) return {};
  const identity = [canonical, manifestPath]
    .map((path) => {
      const st = statSync(path);
      return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    })
    .join("|");
  const cached = resourceEnvironments.get(canonical);
  if (cached?.identity === identity) return cached.environment;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.terminfo === undefined ||
    !["tmux-ide-native-grid-v1", "tmux-ide-native-grid-v2"].includes(manifest.extension)
  )
    return {};
  // Immutable bundle owners validate once; commands/resizes reuse the sealed environment.
  // In-place catalog edits after owner admission are unsupported; this is not per-command tamper detection.
  if (validateBundledTmux(root) !== canonical)
    throw new Error("Bundled terminfo executable mismatch");
  const directory = realpathSync(join(root, "share/terminfo"));
  if (!directory.startsWith(`${root}${sep}`))
    throw new Error("Bundled terminfo directory escapes bundle");
  const environment = Object.freeze({ TERMINFO_DIRS: `${directory}:` });
  resourceEnvironments.set(canonical, { identity, environment });
  return environment;
}

/** Preserve pre-existing trusted search configuration; only add this selected bundle's catalog. */
export function withBundledTmuxResources(
  executable: string | undefined,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const resources = bundledTmuxResourceEnvironment(executable);
  if (!resources.TERMINFO_DIRS || environment.TERMINFO_DIRS?.startsWith(resources.TERMINFO_DIRS))
    return environment;
  return {
    ...environment,
    TERMINFO_DIRS: resources.TERMINFO_DIRS + (environment.TERMINFO_DIRS ?? ""),
  };
}
