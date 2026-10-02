import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Verify all ordered patch inputs before creating or changing a build tree. */
export function readTmuxNativePatches(provenance, directory) {
  if (provenance?.schemaVersion !== 1) throw new Error("Unknown tmux provenance schema");
  const entries = provenance.patches ?? [
    { patch: provenance.patch, patchSha256: provenance.patchSha256 },
  ];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8)
    throw new Error("Invalid tmux patch stack");
  // Keep the legacy grid identity available to existing manifest consumers.
  if (entries[0]?.patch !== provenance.patch || entries[0]?.patchSha256 !== provenance.patchSha256)
    throw new Error("Primary tmux patch identity mismatch");
  const seen = new Set();
  return entries.map((entry) => {
    if (
      !entry ||
      typeof entry.patch !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*\.patch$/u.test(entry.patch) ||
      typeof entry.patchSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.patchSha256) ||
      seen.has(entry.patch)
    )
      throw new Error("Invalid tmux patch identity");
    seen.add(entry.patch);
    const path = resolve(directory, entry.patch);
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.patchSha256)
      throw new Error(`tmux source patch checksum mismatch: ${entry.patch}`);
    return Object.freeze({ path, bytes });
  });
}
