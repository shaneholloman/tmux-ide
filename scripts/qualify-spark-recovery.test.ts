/** Opt-in physical phase; prepared managed owners only, no owner creation or automatic retry. */
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { createRoot } from "solid-js";
import { createApplicationPaneActivityOwner } from "../packages/daemon/src/tui/mirror/runtime/application-pane-activity-owner.ts";
import { expect, it } from "vitest";
import { readSparkCanonicalConfig } from "./qualify-spark-canonical.ts";
import { createMacProcessIdentity } from "./lib/owned-ssh-fixture.mjs";
import { qualifySparkHomeRecovery } from "./lib/spark-recovery.ts";
import { createSparkRetainedTuiObserver } from "./lib/spark-retained-tui.ts";
import { createSparkRemoteAction } from "./lib/spark-remote-action.ts";

it("selects the actual client Solid runtime before admitting a physical fixture", () => {
  let subscribed = false;
  let dispose!: () => void;
  const server = {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "00000000-0000-4000-8000-000000000001",
  };
  createRoot((cleanup) => {
    dispose = cleanup;
    createApplicationPaneActivityOwner(
      () => [
        {
          environmentId: "00000000-0000-4000-8000-000000000001",
          server,
          baseUrl: "http://127.0.0.1:1",
          ownerToken: "never-sent",
        },
      ],
      () => {
        subscribed = true;
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          ready: Promise.resolve(),
          done,
          close: () => finish(),
          getCursor: () => ({ server, cursor: 0 }),
          getObservationStatus: () => null,
        };
      },
    );
  });
  try {
    expect(subscribed).toBe(true);
  } finally {
    dispose();
  }
});
it.skipIf(!process.env.SPARK_RECOVERY_CONFIG)(
  "retains actual Home owner across physical SSH loss and managed replacement",
  async () => {
    const path = resolve(process.env.SPARK_RECOVERY_CONFIG!);
    const config = readSparkCanonicalConfig(path);
    const parent = dirname(path);
    writeFileSync(
      join(parent, "recovery-attempt.json"),
      JSON.stringify({ version: 1, scope: "physical-home-owner-reconnect-replay-replacement" }) +
        "\n",
      { mode: 0o600, flag: "wx" },
    );
    const lifetime = new AbortController();
    const cancel = () => lifetime.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    let allocated: { disposeFiles(): Promise<void> } | undefined;
    let result: Awaited<ReturnType<typeof qualifySparkHomeRecovery>> | undefined;
    let retained: Awaited<ReturnType<typeof createSparkRetainedTuiObserver>> | undefined;
    try {
      const identity = await createMacProcessIdentity({
        parent,
        onAllocated: (value: typeof allocated) => {
          allocated = value;
        },
      });
      if (process.env.SPARK_RETAINED_TUI === "1") {
        const qualifiedTuiDescriptor = process.env.SPARK_QUALIFIED_TUI_DESCRIPTOR;
        assert(
          qualifiedTuiDescriptor,
          "Physical retained TUI requires qualified artifact descriptor",
        );
        const driver = config.remote.driver;
        const action = createSparkRemoteAction({
          root: driver.root,
          node: driver.tools.node.path,
          target: config.ssh.alias,
          config: config.ssh.config,
        });
        retained = await createSparkRetainedTuiObserver({
          config,
          qualifiedTuiDescriptor,
          parent,
          signal: lifetime.signal,
          identify: identity.identify,
          remoteOutput: (stage) => action(`tui-output-${stage}`),
        });
      }
      result = await qualifySparkHomeRecovery({
        config,
        signal: lifetime.signal,
        identify: identity.identify,
        ...(retained ? { retainedTui: retained } : {}),
        persistReplacementLease: (lease) =>
          writeFileSync(
            join(parent, "recovery-new-lease.json"),
            JSON.stringify({
              version: 1,
              instance: config.remote.lease.instance,
              expected: lease,
            }) + "\n",
            { mode: 0o600, flag: "wx" },
          ),
      });
      writeFileSync(join(parent, "recovery-result.json"), JSON.stringify(result) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      if (retained) {
        try {
          await retained.close();
        } catch {
          /* Keep incomplete cleanup evidence and managed records. */
        }
        writeFileSync(
          join(parent, "retained-tui-result.json"),
          JSON.stringify(retained.report()) + "\n",
          {
            mode: 0o600,
            flag: "wx",
          },
        );
      }
      if (result?.cleanup && (!retained || retained.report().cleanup))
        await allocated?.disposeFiles();
    }
    assert(
      result?.ok && (!retained || retained.report().retainedTuiQualified),
      "Physical recovery qualification failed; retain private records and perform guarded managed cleanup",
    );
  },
);
