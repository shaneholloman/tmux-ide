import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const installer = path.resolve("docs/public/install.sh");
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const bin = path.join(root, "tools");
  const prefix = path.join(root, "install space ' quote");
  fs.mkdirSync(bin);
  function script(name, body) {
    fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nset -eu\n" + body, { mode: 0o755 });
  }
  script(
    "uname",
    `case "$1" in -s) echo ${platform === "darwin" ? "Darwin" : "Linux"} ;; -m) echo ${arch === "arm64" ? "arm64" : "x86_64"} ;; esac\n`,
  );
  script("tmux-ide", "echo stale-PATH-version; exit 99\n");
  const sha = createHash("sha256").update("archive").digest("hex");
  script(
    "curl",
    `url=''; out=''; while [ "$#" -gt 0 ]; do case "$1" in https:*) url=$1 ;; -o) shift; out=$1 ;; esac; shift; done
case "$url" in *SHASUMS256.txt) printf '%s  node-v24.1.0-${target}.tar.gz\\n' '${sha}' > "$out" ;; *) printf '%s' "\${MOCK_ARCHIVE:-archive}" > "$out" ;; esac\n`,
  );
  const npm = path.join(root, "npm.mjs");
  fs.writeFileSync(
    npm,
    `import fs from 'node:fs'; import path from 'node:path';
if (process.env.MOCK_NPM_FAIL) process.exit(1);
const prefix=process.argv[process.argv.indexOf('--prefix')+1];
const root=path.join(prefix,'lib/node_modules/tmux-ide');
for (const dir of ['bin','scripts','packages/daemon/dist/native/tmux/${target}']) fs.mkdirSync(path.join(root,dir),{recursive:true});
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'2.9.0'}));
fs.writeFileSync(path.join(root,'bin/cli.js'), "if(process.env.MOCK_TUI_FAIL && process.argv.includes('--tui-binary')) process.exit(1); console.log(process.env.MOCK_BAD_VERSION ? 'tmux-ide v0.0.0' : 'tmux-ide v2.9.0');");
fs.writeFileSync(path.join(root,'scripts/postinstall.js'), "require('node:fs').appendFileSync(process.env.HOME+'/postinstall', 'installed\\\\n');");
fs.writeFileSync(path.join(root,'packages/daemon/dist/native/tmux/${target}/manifest.json'),JSON.stringify({minimumMacOS:'1.0',minimumGlibc:'1.0'}));
if (!process.env.MOCK_MISSING_TMUX) fs.writeFileSync(path.join(root,'packages/daemon/dist/native/tmux/${target}/tmux'),'#!/bin/sh\\necho tmux 3.7c\\n');
`,
  );
  const node = process.execPath;
  script(
    "tar",
    `while [ "$1" != '-C' ]; do shift; done; shift
mkdir -p "$1/bin"
ln -s ${quote(node)} "$1/bin/node"
printf '%s\\n' '#!/bin/sh' 'exec ${node} ${quote(npm).replaceAll("'", "'\\''")} "$@"' > "$1/bin/npm"
chmod +x "$1/bin/npm"\n`,
  );
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    TMUX_IDE_RUNTIME_MODE: "",
  };
  const run = (extra = {}, args = []) =>
    spawnSync("/bin/sh", [installer, "--prefix", prefix, ...args], {
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  return { root, prefix, run };
}

test("fresh install and upgrade work with spaces and shell punctuation", (t) => {
  const { root, prefix, run } = fixture(t);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const current = path.join(prefix, "share/tmux-ide/current");
  const previous = fs.readlinkSync(current);
  const launch = spawnSync(path.join(prefix, "bin/tmux-ide"), ["--version"], { encoding: "utf8" });
  assert.equal(launch.status, 0, launch.stderr);
  assert.match(launch.stdout, /v2.9.0/);
  assert.equal(run().status, 0);
  assert.notEqual(fs.readlinkSync(current), previous);
  assert.ok(fs.existsSync(previous), "keep runtime files for existing processes");
  assert.ok(fs.existsSync(path.join(root, "postinstall")));
});
for (const [label, failure] of [
  ["checksum mismatch", { MOCK_ARCHIVE: "corrupt" }],
  ["npm failure", { MOCK_NPM_FAIL: "1" }],
  ["mismatched CLI version", { MOCK_BAD_VERSION: "1" }],
  ["TUI download failure", { MOCK_TUI_FAIL: "1" }],
  ["missing platform bundle", { MOCK_MISSING_TMUX: "1" }],
])
  test(`${label} preserves an existing installation`, (t) => {
    const { prefix, run } = fixture(t);
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const root = path.join(prefix, "share/tmux-ide");
    const previous = fs.readlinkSync(path.join(root, "current"));
    assert.notEqual(run(failure).status, 0);
    assert.equal(fs.readlinkSync(path.join(root, "current")), previous);
    assert.ok(!fs.existsSync(path.join(root, "install.lock")));
    assert.ok(fs.readdirSync(path.join(root, "releases")).every((x) => !x.startsWith(".install.")));
  });
test("unmanaged launcher is preserved", (t) => {
  const { prefix, run } = fixture(t);
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  const launcher = path.join(prefix, "bin/tmux-ide");
  fs.writeFileSync(launcher, "existing");
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(launcher, "utf8"), "existing");
});
