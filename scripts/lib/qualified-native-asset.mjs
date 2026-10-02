import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { validateNativeScrollReleaseManifest } from "./native-scroll-release-manifest.mjs";

export const NATIVE_ASSET_NAMESPACE = "tmux-ide-opentui-worker-asset";

/** Only a validated release may redirect OpenTUI's otherwise unused stock asset. */
export function qualifiedNativeAssetRedirect(manifestPath, options) {
  if (!manifestPath) return null;
  const { library, manifest } = validateNativeScrollReleaseManifest(manifestPath, options);
  const packageName = `@opentui/core-${manifest.platform}-${manifest.arch}`;
  const importer = realpathSync(options.resolveHostModule(packageName));
  const packageRoot = dirname(importer);
  const metadata = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, packageName, "Native asset package does not match release host");
  assert.equal(metadata.version, manifest.coreVersion, "Native asset package ABI mismatch");
  assert.equal(metadata.exports?.["."]?.bun, "./index.bun.js", "Unknown native asset entry");
  assert.equal(importer, realpathSync(resolve(packageRoot, "index.bun.js")));
  const specifier = manifest.platform === "darwin" ? "./libopentui.dylib" : "./libopentui.so";
  const stockLibrary = realpathSync(resolve(packageRoot, specifier));
  return Object.freeze({
    library,
    stockLibrary,
    resolve(args) {
      if (args.path !== specifier || !args.importer) return undefined;
      let candidate;
      try {
        candidate = realpathSync(args.importer);
      } catch {
        return undefined;
      }
      if (candidate !== importer) return undefined;
      // Same path AND namespace as the explicit qualified-library import:
      // Bun embeds one asset and the runtime keeps its existing shared handle.
      return { path: library, namespace: NATIVE_ASSET_NAMESPACE };
    },
  });
}

/** Static release proof; does not execute or prewarm the newly compiled TUI. */
export function assertQualifiedNativeAssetDeduplicated(outfile, redirect) {
  const binary = readFileSync(outfile);
  const qualified = readFileSync(redirect.library);
  const stock = readFileSync(redirect.stockLibrary);
  assert(qualified.length > 0 && stock.length > 0, "Empty native asset");
  assert(!qualified.equals(stock), "Qualified and stock native assets are identical");
  assert.equal(binary.indexOf(stock), -1, "Compiled release still embeds the stock native asset");
  const first = binary.indexOf(qualified);
  assert(first >= 0, "Compiled release is missing the qualified native asset");
  assert.equal(
    binary.indexOf(qualified, first + 1),
    -1,
    "Compiled release embeds the qualified native asset more than once",
  );
  return Object.freeze({ qualifiedBytes: qualified.length, removedStockBytes: stock.length });
}
