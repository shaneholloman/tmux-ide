import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

// One authoritative installer suite serves the daemon gate and Node 20 package
// checks. The universal installer now owns its runtime and npm prefix, so the
// former system-Node/global-manager fixtures no longer describe its contract.
it("qualifies isolated installer activation, version verification, and failed upgrades", () => {
  const output = execFileSync(process.execPath, ["--test", "scripts/install.test.mjs"], {
    cwd: resolve("../.."),
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(output).toMatch(/(?:#|ℹ) fail 0/u);
}, 65_000);
