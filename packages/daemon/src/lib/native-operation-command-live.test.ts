import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { nativeOperationWrapperArgs } from "./native-operation-command.ts";
const binary = process.env.TMUX_IDE_NATIVE_JOURNAL_TEST_BINARY;
it.skipIf(!binary)("preserves literal payloads through the actual tmux string parser", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-operation-literals-"));
  const socket = join(root, "owned.sock");
  const run = (...args: string[]) =>
    execFileSync(binary!, ["-S", socket, ...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    run("-f", "/dev/null", "new-session", "-d", "-s", "literal-proof");
    for (const payload of [
      ";",
      "' ; kill-server ; '",
      "${HOME} `uname` $(uname)",
      "#{pid}",
      "a\nb\rc\t雪",
    ]) {
      const argv = nativeOperationWrapperArgs("00000000-0000-4000-8000-000000000001", [
        ["set-buffer", "-b", "proof", "--", payload],
      ]);
      // This exercises the same native string parser before the optional -I
      // extension is available, without touching an installed/user server.
      run("if-shell", "-F", "1", argv.at(-1)!);
      expect(run("save-buffer", "-b", "proof", "-")).toBe(payload);
    }
  } finally {
    try {
      run("kill-server");
    } catch {
      /* fixture already exited */
    }
    rmSync(root, { recursive: true, force: true });
  }
});
