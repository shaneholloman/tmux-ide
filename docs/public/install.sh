#!/bin/sh
# curl -fsSL https://tmux.thijsverreck.com/install.sh | sh
set -eu
fail() { printf 'tmux-ide: %s\n' "$*" >&2; exit 1; }
fetch() { curl -fLsS --retry 3 --connect-timeout 15 --max-time 180 "$1" -o "$2"; }
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}
main() {
  version=latest
  prefix=${TMUX_IDE_INSTALL_PREFIX:-"$HOME/.local"}
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version|--prefix)
        [ "$#" -ge 2 ] || fail "$1 requires a value"
        case "$1" in --version) version=$2 ;; --prefix) prefix=$2 ;; esac
        shift 2 ;;
      --help) printf 'Usage: install.sh [--version VERSION|beta|latest] [--prefix ABSOLUTE_PATH]\n'; return ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  case "$prefix" in /*) ;; *) fail 'Install prefix must be absolute' ;; esac
  case "$version" in ''|*[!a-zA-Z0-9.+-]*) fail 'Invalid version or channel' ;; esac
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux; getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'Linux requires glibc (musl/Alpine is not supported)' ;;
    *) fail 'Supported systems: macOS and glibc Linux, including supported WSL distributions' ;;
  esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Supported architectures: ARM64 and x64' ;; esac
  for tool in curl tar gzip awk mktemp grep; do command -v "$tool" >/dev/null 2>&1 || fail "Missing required tool: $tool"; done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail 'A SHA-256 tool is required'
  root="$prefix/share/tmux-ide"
  launcher="$prefix/bin/tmux-ide"
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    [ -f "$root/installer-v1" ] && grep -q '^# tmux-ide universal installer v1$' "$launcher" || fail "Refusing to replace an unmanaged installation at $launcher"
  fi
  mkdir -p "$root/releases" "$prefix/bin"
  mkdir "$root/install.lock" 2>/dev/null || fail "Another installation is running (lock: $root/install.lock)"
  stage=''
  trap '[ -z "$stage" ] || rm -rf "$stage"; rmdir "$root/install.lock" 2>/dev/null || true' 0
  trap 'exit 1' INT TERM
  stage=$(mktemp -d "$root/releases/.install.XXXXXX")
  printf 'Installing tmux-ide@%s for %s-%s…\n' "$version" "$os" "$arch"
  fetch https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt "$stage/SHASUMS256.txt"
  archive=$(awk -v suffix="-$os-$arch.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$stage/SHASUMS256.txt")
  case "$archive" in ''|*[!a-zA-Z0-9.-]*) fail 'Could not resolve an official Node.js archive' ;; esac
  expected=$(awk -v file="$archive" '$2==file {print $1}' "$stage/SHASUMS256.txt")
  [ "${#expected}" -eq 64 ] || fail 'Invalid Node.js checksum manifest'
  fetch "https://nodejs.org/dist/latest-v24.x/$archive" "$stage/node.tar.gz"
  [ "$(digest "$stage/node.tar.gz")" = "$expected" ] || fail 'Node.js checksum mismatch'
  mkdir "$stage/node"
  tar -xzf "$stage/node.tar.gz" --strip-components=1 -C "$stage/node"
  export PATH="$stage/node/bin:$PATH"
  # Prepare without touching a running daemon. Its supported upgrade runs only
  # after the verified installation has moved to its permanent location.
  TMUX_IDE_RUNTIME_MODE=development npm install --global --prefix "$stage/npm" "tmux-ide@$version"
  cli="$stage/npm/lib/node_modules/tmux-ide/bin/cli.js"
  installed=$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$stage/npm/lib/node_modules/tmux-ide/package.json")
  [ "$(node "$cli" --version)" = "tmux-ide v$installed" ] || fail 'Installed CLI version does not match its package'
  case "$version" in [0-9]*.*.*) [ "$installed" = "$version" ] || fail 'Installed package does not match the requested version' ;; esac
  native="$stage/npm/lib/node_modules/tmux-ide/packages/daemon/dist/native/tmux/$os-$arch/tmux"
  [ -f "$native" ] || fail "This version does not bundle tmux for $os-$arch; the existing installation is unchanged"
  node --input-type=module - "$(dirname "$native")/manifest.json" <<'JS'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const mac = process.platform === 'darwin';
const minimum = mac ? manifest.minimumMacOS : manifest.minimumGlibc;
const current = mac
  ? execFileSync('/usr/bin/sw_vers', ['-productVersion'], {encoding: 'utf8'}).trim()
  : process.report.getReport().header.glibcVersionRuntime;
const parts = value => String(value).split('.').map(Number);
const required = parts(minimum), installed = parts(current);
if (!minimum || !current || required.some(Number.isNaN) || installed.some(Number.isNaN)) throw new Error('Cannot verify bundled tmux OS requirements');
let compatible = true;
for (let i = 0; i < Math.max(required.length, installed.length); i++) {
  const difference = (installed[i] || 0) - (required[i] || 0);
  if (difference) { compatible = difference > 0; break; }
}
if (!compatible) throw new Error(`Bundled tmux requires ${mac ? 'macOS' : 'glibc'} ${minimum}+; found ${current}. Existing installation unchanged.`);
JS
  chmod +x "$native"
  "$native" -V
  node "$cli" update --tui-binary
  rm "$stage/node.tar.gz" "$stage/SHASUMS256.txt"
  node --input-type=module - "$root" "$prefix" "$stage" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const [root, prefix, stage] = process.argv.slice(2);
const destination = path.join(root, 'releases', path.basename(stage).replace('.install.', 'install-'));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = `#!/bin/sh\n# tmux-ide universal installer v1\nroot=${quote(root)}\nexport PATH="$root/current/node/bin:$PATH"\nexport npm_config_prefix="$root/current/npm"\nexec "$root/current/node/bin/node" "$root/current/npm/lib/node_modules/tmux-ide/bin/cli.js" "$@"\n`;
const temporaryLauncher = path.join(prefix, 'bin', '.tmux-ide-install');
fs.writeFileSync(temporaryLauncher, launcher, {mode: 0o755});
fs.renameSync(stage, destination);
const next = path.join(root, 'current.next');
try { fs.unlinkSync(next); } catch (error) { if (error.code !== 'ENOENT') throw error; }
fs.symlinkSync(destination, next);
fs.renameSync(next, path.join(root, 'current'));
fs.renameSync(temporaryLauncher, path.join(prefix, 'bin', 'tmux-ide'));
fs.writeFileSync(path.join(root, 'installer-v1'), '1\n');
console.log(`Add this to your shell profile if needed:\n  export PATH=${quote(path.join(prefix, 'bin'))}:"$PATH"`);
JS
  export PATH="$root/current/node/bin:$PATH"
  npm_config_global=true node "$root/current/npm/lib/node_modules/tmux-ide/scripts/postinstall.js"
  "$launcher" --version
  printf '\nInstalled. Start with: %s\nExisting tmux sessions are preserved. Reopen any running tmux-ide UI.\n' "$launcher"
}
main "$@"
