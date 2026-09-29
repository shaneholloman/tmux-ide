/** Private qualification secondary. Implement remotely for physical-host tests. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTmuxServerProbe } from "../../packages/daemon/src/lib/tmux-server-registration.ts";

export interface CanonicalSshSecondary {
  readonly retainedRoot: string;
  start(semanticPaneId: string): Promise<{ socket: string }>;
  seed(): Promise<void>;
  retire(): Promise<void>;
  removeFiles(): void | Promise<void>;
}
export function createLocalCanonicalSecondary(options: {
  privateParent: string;
  executable: string;
  session: string;
  identify(pid: number): Promise<string | null>;
}): CanonicalSshSecondary {
  const execute = promisify(execFile);
  const root = mkdtempSync(join(options.privateParent, "n-"));
  const socket = join(root, "s");
  const run = async (args: string[]) =>
    (
      await execute(options.executable, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, TMUX: "" },
      })
    ).stdout.trim();
  let tmuxAttempted = false;
  let retired = false;
  let observation:
    | NonNullable<Awaited<ReturnType<ReturnType<typeof createTmuxServerProbe>>>>
    | undefined;
  let witness: string | null = null;
  return {
    retainedRoot: root,
    async start(semanticPaneId) {
      assert(!tmuxAttempted && !retired, "Secondary fixture already started or retired");
      tmuxAttempted = true;
      await run(["new-session", "-d", "-s", options.session, "cat"]);
      observation =
        (await createTmuxServerProbe(options.executable)({ kind: "path", path: socket })) ??
        undefined;
      assert(observation?.nativeServerIdentity);
      const witnessDeadline = Date.now() + 1500;
      while (!witness && Date.now() < witnessDeadline) {
        try {
          witness = await options.identify(Number(observation.nativeServerIdentity.pid));
        } catch {
          /* No mutation is authorized by an unadmitted witness. */
        }
        if (!witness) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert(witness && observation.valid());
      const confirmed = await createTmuxServerProbe(options.executable)({
        kind: "path",
        path: socket,
      });
      assert.equal(confirmed?.fingerprint, observation.fingerprint);
      await run([
        "set-option",
        "-p",
        "-t",
        options.session + ":0.0",
        "@tmux_ide_pane_id",
        semanticPaneId,
      ]);
      await run([
        "set-option",
        "-p",
        "-t",
        options.session + ":0.0",
        "@agent_state",
        `idle:${Date.now()}`,
      ]);
      return { socket };
    },
    async seed() {
      assert(observation && witness && !retired, "Secondary fixture is not admitted");
      await run(["send-keys", "-t", options.session + ":0.0", "-l", "owned-secondary-marker"]);
      await run(["send-keys", "-t", options.session + ":0.0", "Enter"]);
    },
    async retire() {
      if (tmuxAttempted && !observation)
        throw Error("Private tmux creation outcome has no admitted witness");
      if (!observation) {
        retired = true;
        return;
      }
      const identity = observation!.nativeServerIdentity!;
      assert(
        witness &&
          (await options.identify(Number(identity.pid))) === witness &&
          observation!.valid(),
      );
      const current = await createTmuxServerProbe(options.executable)({
        kind: "path",
        path: socket,
      });
      assert.equal(current?.fingerprint, observation!.fingerprint);
      const guard = `#{&&:#{==:#{pid},${identity.pid}},#{==:#{start_time},${identity.startTime}}}`;
      assert.equal(
        await run(["if-shell", "-F", guard, "kill-server", "display-message -p refused"]),
        "",
      );
      const end = Date.now() + 3000;
      while ((await options.identify(Number(identity.pid))) !== null) {
        if (Date.now() > end) throw Error("Private tmux exit unproven");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      retired = true;
    },
    removeFiles() {
      assert(retired, "Secondary retirement must be verified before file removal");
      rmSync(root, { recursive: true });
    },
  };
}
