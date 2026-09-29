import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NATIVE_SCROLL_RELEASE_PINS,
  nativeScrollSha256,
} from "./native-scroll-release-manifest.mjs";
import {
  assertQualifiedNativeAssetDeduplicated,
  NATIVE_ASSET_NAMESPACE,
  qualifiedNativeAssetRedirect,
} from "./qualified-native-asset.mjs";

function fixture(t, platform = "darwin", arch = "arm64") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qualified-native-asset-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, `node_modules/@opentui/core-${platform}-${arch}`);
  for (const dir of [
    host,
    join(root, "patches"),
    join(root, "scripts/native"),
    join(root, "output"),
  ])
    mkdirSync(dir, { recursive: true });
  const extension = platform === "darwin" ? "dylib" : "so";
  const importer = join(host, "index.bun.js");
  const specifier = `./libopentui.${extension}`;
  const metadata = {
    name: `@opentui/core-${platform}-${arch}`,
    version: NATIVE_SCROLL_RELEASE_PINS.coreVersion,
    exports: { ".": { bun: "./index.bun.js" } },
  };
  writeFileSync(join(host, "package.json"), JSON.stringify(metadata));
  writeFileSync(importer, `export { default } from ${JSON.stringify(specifier)};`);
  writeFileSync(join(host, specifier), "stock native bytes");
  const patch = join(root, "patches/opentui-native-scroll-ad9a818.patch");
  const recipe = join(root, "scripts/native/build-opentui-scroll.mjs");
  writeFileSync(patch, "pinned patch");
  writeFileSync(recipe, "pinned recipe");
  const artifact = (name, bytes = name) => {
    const path = join(root, "output", name);
    writeFileSync(path, bytes);
    return { path: name, sha256: nativeScrollSha256(path) };
  };
  const manifest = {
    version: 1,
    status: "passed",
    ...NATIVE_SCROLL_RELEASE_PINS,
    platform,
    arch,
    libc: platform === "linux" ? "glibc" : null,
    patchSha256: nativeScrollSha256(patch),
    recipeSha256: nativeScrollSha256(recipe),
    tests: artifact("tests.log"),
    build: artifact("build.log"),
    library: artifact(`libopentui.${extension}`, "qualified native bytes"),
  };
  const path = join(root, "output/release-manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  const options = {
    repository: root,
    target: `bun-${platform}-${arch}`,
    platform,
    arch,
    libc: manifest.libc,
    sourceState: "clean",
    coreVersion: manifest.coreVersion,
    resolveHostModule(name) {
      assert.equal(name, metadata.name);
      return importer;
    },
  };
  return {
    root,
    host,
    importer,
    specifier,
    metadata,
    manifest,
    path,
    options,
    redirect: () => qualifiedNativeAssetRedirect(path, options),
  };
}

test("stock and experimental builds do not resolve or redirect host assets", () => {
  assert.equal(qualifiedNativeAssetRedirect(null, null), null);
});

for (const [platform, arch] of [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
]) {
  test(`redirects only the exact ${platform}/${arch} host package asset`, (t) => {
    const f = fixture(t, platform, arch);
    const redirect = f.redirect();
    assert.deepEqual(redirect.resolve({ path: f.specifier, importer: f.importer }), {
      path: join(f.root, "output", f.manifest.library.path),
      namespace: NATIVE_ASSET_NAMESPACE,
    });
    const unrelated = join(f.root, "index.bun.js");
    writeFileSync(unrelated, "unrelated module");
    for (const args of [
      { path: f.specifier, importer: unrelated },
      { path: f.specifier, importer: join(f.host, "missing.js") },
      { path: "./other.dylib", importer: f.importer },
      { path: `../${f.specifier.slice(2)}`, importer: f.importer },
      { path: f.specifier, importer: "" },
    ])
      assert.equal(redirect.resolve(args), undefined);
  });
}

for (const change of [
  { target: "bun-linux-arm64" },
  { sourceState: "dirty" },
  { coreVersion: "0.6.0" },
]) {
  test(`rejects incompatible qualification ${JSON.stringify(change)}`, (t) => {
    const f = fixture(t);
    assert.throws(() => qualifiedNativeAssetRedirect(f.path, { ...f.options, ...change }));
  });
}

test("rejects musl, tampered library and a failed qualification before host resolution", (t) => {
  const f = fixture(t, "linux");
  const mustNotResolve = () => assert.fail("Unqualified asset must not be resolved");
  assert.throws(
    () =>
      qualifiedNativeAssetRedirect(f.path, {
        ...f.options,
        libc: "musl",
        resolveHostModule: mustNotResolve,
      }),
    /musl/,
  );
  writeFileSync(f.path, JSON.stringify({ ...f.manifest, status: "failed" }));
  assert.throws(
    () => qualifiedNativeAssetRedirect(f.path, { ...f.options, resolveHostModule: mustNotResolve }),
    /did not pass/,
  );
  writeFileSync(f.path, JSON.stringify(f.manifest));
  writeFileSync(join(f.root, "output", f.manifest.library.path), "tampered");
  assert.throws(
    () => qualifiedNativeAssetRedirect(f.path, { ...f.options, resolveHostModule: mustNotResolve }),
    /digest mismatch/,
  );
});

for (const change of [
  { name: "@opentui/core-darwin-x64" },
  { version: "0.6.0" },
  { exports: { ".": { bun: "./different.js" } } },
]) {
  test(`fails closed on changed native package contract ${JSON.stringify(change)}`, (t) => {
    const f = fixture(t);
    writeFileSync(join(f.host, "package.json"), JSON.stringify({ ...f.metadata, ...change }));
    assert.throws(f.redirect);
  });
}

test("compiled-content proof rejects stock, absent and duplicate qualified payloads", (t) => {
  const f = fixture(t);
  const redirect = f.redirect();
  const binary = join(f.root, "compiled");
  for (const [content, message] of [
    ["header:stock native bytes:qualified native bytes", /stock/],
    ["header:no native payload", /missing/],
    ["qualified native bytes:qualified native bytes", /more than once/],
  ]) {
    writeFileSync(binary, content);
    assert.throws(() => assertQualifiedNativeAssetDeduplicated(binary, redirect), message);
  }
  writeFileSync(binary, "header:qualified native bytes:trailer");
  assert.deepEqual(assertQualifiedNativeAssetDeduplicated(binary, redirect), {
    qualifiedBytes: 22,
    removedStockBytes: 18,
  });
});
