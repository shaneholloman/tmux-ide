import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
/** Stage only compiled catalog entries; materialize internal aliases to portable regular files. */
export function stageTerminfoCatalog(roots, output) {
  const sources = roots.map((p) => realpathSync(p));
  assert(sources.length > 0);
  const entries = new Map();
  let bytes = 0;
  for (const root of sources) {
    assert(lstatSync(root).isDirectory());
    for (const group of readdirSync(root).sort()) {
      assert(/^(?:[A-Za-z0-9]|[0-9a-fA-F]{2})$/.test(group), "Invalid terminfo bucket");
      const directory = join(root, group);
      assert(
        lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
        "Invalid terminfo bucket",
      );
      for (const name of readdirSync(directory).sort()) {
        assert(/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,127}$/.test(name), "Invalid terminfo entry");
        const path = realpathSync(join(directory, name));
        assert(
          sources.some((r) => {
            const rel = relative(r, path);
            return rel && !isAbsolute(rel) && !rel.startsWith(".." + sep) && rel !== "..";
          }),
          "Terminfo alias escapes catalog",
        );
        const st = lstatSync(path);
        assert(st.isFile() && st.size >= 12 && st.size <= 65536, "Invalid compiled terminfo file");
        const content = readFileSync(path);
        assert(
          [0x011a, 0x021e].includes(content.readUInt16LE(0)),
          "Invalid compiled terminfo magic",
        );
        const key = group + "/" + name,
          hash = digest(path);
        if (entries.has(key)) {
          assert.equal(entries.get(key).sha256, hash, "Conflicting terminfo catalogs");
          continue;
        }
        bytes += st.size;
        assert(bytes <= 64 * 1024 * 1024 && entries.size < 8192, "Terminfo catalog bound exceeded");
        entries.set(key, { path, sha256: hash, bytes: st.size });
      }
    }
  }
  for (const name of ["xterm-256color", "screen-256color", "tmux-256color"])
    assert(
      [...entries.keys()].some((p) => p.endsWith("/" + name)),
      `Required terminfo missing: ${name}`,
    );
  assert(!existsSync(output), "Terminfo output already exists");
  mkdirSync(output, { recursive: true });
  for (const [name, row] of entries) {
    mkdirSync(dirname(join(output, name)), { recursive: true });
    copyFileSync(row.path, join(output, name));
  }
  return {
    directory: "share/terminfo",
    entries: entries.size,
    bytes,
    files: [...entries.keys()].map((n) => "share/terminfo/" + n),
  };
}
/** Discover only the catalog associated with the resolved ncurses build inputs. */
export function terminfoBuildInputs(platform, libraries, run) {
  if (platform === "darwin") {
    const ncurses = libraries.find((p) => /^libncursesw?\..*\.dylib$/.test(basename(p)));
    assert(ncurses, "Missing bundled ncurses dependency");
    const prefix = dirname(dirname(realpathSync(ncurses))),
      root = join(prefix, "share/terminfo");
    assert(existsSync(root), "ncurses input lacks terminfo catalog");
    return { roots: [root], licenses: [], provenance: { kind: "ncurses-prefix", prefix } };
  }
  assert.equal(platform, "linux");
  const packages = ["ncurses-base", "ncurses-term"];
  const versions = {};
  const roots = [];
  const licenses = [];
  for (const name of packages) {
    versions[name] = run("dpkg-query", ["-W", "-f=${Version}", name]);
    const license = join("/usr/share/doc", name, "copyright");
    assert(existsSync(license), "Missing terminfo redistribution license");
    licenses.push({ source: license, name: `licenses/${name}-terminfo.txt` });
    const paths = run("dpkg-query", ["-L", name]).split("\n");
    for (const root of ["/lib/terminfo", "/usr/share/terminfo"])
      if (
        paths.some((p) => p.startsWith(root + "/")) &&
        existsSync(root) &&
        !roots.includes(realpathSync(root))
      )
        roots.push(realpathSync(root));
  }
  assert(roots.length, "Missing packaged terminfo data");
  return { roots, licenses, provenance: { kind: "debian-packages", packages: versions } };
}
