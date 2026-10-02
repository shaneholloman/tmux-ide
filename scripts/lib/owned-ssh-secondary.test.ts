import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createLocalCanonicalSecondary } from "./owned-ssh-secondary.ts";
import {
  listSessionPanes,
  _setExecutor,
} from "../../packages/daemon/src/widgets/lib/pane-comms.ts";
import { createMacProcessIdentity } from "./owned-ssh-fixture.mjs";

test(
  "real private secondary is seeded and requires verified retirement before removal",
  {
    skip: process.platform !== "darwin",
    timeout: 15000,
  },
  async () => {
    const root = mkdtempSync("/tmp/tia-secondary-");
    let disposeIdentity: (() => Promise<void>) | undefined;
    let secondary: ReturnType<typeof createLocalCanonicalSecondary> | undefined;
    try {
      const witness = await createMacProcessIdentity({
        parent: root,
        onAllocated: (allocated: { disposeFiles: () => Promise<void> }) => {
          disposeIdentity = allocated.disposeFiles;
        },
      });
      const executable = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
      secondary = createLocalCanonicalSecondary({
        privateParent: root,
        executable,
        session: "secondary-proof",
        identify: witness.identify,
      });
      assert.throws(() => secondary!.removeFiles(), /retirement must be verified/);
      const { socket } = await secondary.start("pane.shared");
      // Machine-readable metadata must survive a daemon launched without a UTF-8 locale.
      execFileSync(
        executable,
        ["-u", "-S", socket, "select-pane", "-t", "secondary-proof:0.0", "-T", "café"],
        { timeout: 2000 },
      );
      const restoreExecutor = _setExecutor((_command, args) =>
        execFileSync(executable, ["-S", socket, ...args], {
          encoding: "utf8",
          timeout: 2000,
          env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, LANG: "C", LC_ALL: "C" },
        }),
      );
      try {
        const panes = listSessionPanes("secondary-proof");
        assert.equal(panes.length, 1);
        assert.equal(panes[0]!.title, "café");
        assert.equal(panes[0]!.index, 0);
        assert.equal(panes[0]!.currentCommand, "cat");
        assert(panes[0]!.width > 0 && panes[0]!.height > 0);
      } finally {
        restoreExecutor();
      }
      await secondary.seed();
      let captured = "";
      const deadline = Date.now() + 3000;
      while (!captured.includes("owned-secondary-marker")) {
        assert(Date.now() < deadline, "Actual secondary did not receive marker");
        captured = execFileSync(
          executable,
          ["-S", socket, "capture-pane", "-p", "-t", "secondary-proof:0.0"],
          { encoding: "utf8", timeout: 2000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.throws(() => secondary!.removeFiles(), /retirement must be verified/);
      assert(existsSync(socket));
    } finally {
      if (secondary) {
        await secondary.retire();
        secondary.removeFiles();
        assert(!existsSync(secondary.retainedRoot));
      }
      await disposeIdentity?.();
      rmSync(root, { recursive: true });
    }
  },
);
