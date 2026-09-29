/** Fixed managed-owner actions for the isolated physical Spark qualification. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import {
  developmentSshAuthority,
  developmentSshHandshake,
} from "../../packages/daemon/src/lib/development-ssh.ts";
import { readTmux, socketIdentity } from "../../packages/daemon/src/lib/development-lifecycle.ts";
import { writeDevelopmentRecord } from "../../packages/daemon/src/lib/development-state.ts";
import { developmentFileHash } from "../../packages/daemon/src/lib/development-build.ts";
import { revalidateUnixSocketIdentity } from "../../packages/daemon/src/lib/unix-socket-authority.ts";
import { createTmuxServerProbe } from "../../packages/daemon/src/lib/tmux-server-registration.ts";
import { fenceNativeTmuxCommand } from "../../packages/daemon/src/lib/tmux-server-generation-runner.ts";
import { sparkProcessWitness } from "./spark-process-witness.ts";
import {
  sparkDriverEnvironment,
  type SparkDriverRuntimeDescriptor,
} from "./spark-driver-runtime.ts";

export interface SparkManagedDescriptor extends SparkDriverRuntimeDescriptor {
  instance: { worktree: string; name: string; store: string };
}
export const SPARK_FIXTURE_SESSION = "attribution-collision";
type ManagedAction = "prepare" | "stamp-blocked" | "stamp-done" | "replace-owner";

export function sparkManagerArgv(
  d: SparkManagedDescriptor,
  action: "rebuild" | "up" | "down" | "status" | "reset",
) {
  return [
    join(d.source.path, "scripts/development-instance.mjs"),
    action,
    ...(action === "rebuild" ? ["--bun", d.tools.bun.path] : []),
    ...(action === "down" ? ["--daemon-only"] : []),
    ...(action === "reset" ? ["--yes"] : []),
    "--worktree",
    d.instance.worktree,
    "--name",
    d.instance.name,
    "--store",
    d.instance.store,
    "--json",
  ];
}

/** Caller holds the driver lock and has validated the complete descriptor and runtime. */
export async function sparkManagedAction(d: SparkManagedDescriptor, action: ManagedAction) {
  assert(["prepare", "stamp-blocked", "stamp-done", "replace-owner"].includes(action));
  const instance = resolveDevelopmentInstance(d.instance);
  const execute = promisify(execFile);
  const env = {
    ...sparkDriverEnvironment(d.root),
    PATH: `${dirname(d.tools.node.path)}:${dirname(d.tools.bun.path)}:/usr/bin:/bin`,
  };
  const manager = async (verb: "rebuild" | "up" | "down") => {
    const result = await execute(d.tools.node.path, sparkManagerArgv(d, verb), {
      cwd: d.source.path,
      env,
      encoding: "utf8",
      timeout: verb === "rebuild" ? 240000 : 60000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  };
  const publish = async () => {
    const { lease } = await developmentSshAuthority(instance);
    writeDevelopmentRecord(join(d.root, "lease.json"), {
      version: 1,
      instance: d.instance,
      expected: lease,
    });
    return lease;
  };
  const tmuxAuthority = async () => {
    await developmentSshAuthority(instance);
    const record = readTmux(instance);
    assert(record);
    assert.equal(developmentFileHash(record.executable), d.tools.native.sha256);
    revalidateUnixSocketIdentity(socketIdentity(record));
    const witness = sparkProcessWitness(record.pid, d.execution);
    assert(witness);
    const observation = await createTmuxServerProbe(record.executable)({
      kind: "path",
      path: record.socket.path,
    });
    assert(observation?.nativeServerIdentity && observation.valid());
    assert.equal(Number(observation.nativeServerIdentity.pid), record.pid);
    return {
      record,
      witness,
      run: async (args: string[]) => {
        assert.equal(sparkProcessWitness(record.pid, d.execution), witness);
        revalidateUnixSocketIdentity(socketIdentity(record));
        const command = fenceNativeTmuxCommand(args, observation.nativeServerIdentity!);
        const result = await execute(
          record.executable,
          ["-u", "-S", record.socket.path, "-N", ...command.argv],
          {
            env,
            encoding: "utf8",
            timeout: 5000,
            killSignal: "SIGKILL",
            maxBuffer: 65536,
          },
        );
        return command.verify(result.stdout).trim();
      },
    };
  };
  if (action === "prepare") {
    assert(!existsSync(instance.root), "Managed qualification instance already exists");
    writeFileSync(
      join(d.root, "prepare-attempt.json"),
      JSON.stringify({ version: 1, attempted: true }),
      { flag: "wx", mode: 0o600 },
    );
    await manager("rebuild");
    await manager("up");
    const tmux = await tmuxAuthority();
    await tmux.run([
      "new-session",
      "-d",
      "-s",
      SPARK_FIXTURE_SESSION,
      "-c",
      d.source.path,
      "/bin/sh",
    ]);
    await tmux.run([
      "set-option",
      "-p",
      "-t",
      `${SPARK_FIXTURE_SESSION}:0.0`,
      "@tmux_ide_pane_id",
      "pane.shared",
    ]);
    await tmux.run([
      "set-option",
      "-p",
      "-t",
      `${SPARK_FIXTURE_SESSION}:0.0`,
      "@agent_state",
      `idle:${Date.now()}`,
    ]);
    const { lease } = await developmentSshAuthority(instance);
    const handshake = JSON.parse(await developmentSshHandshake(instance, lease));
    // Consume credentials only inside this private action, never return them.
    const response = await fetch(`http://127.0.0.1:${lease.port}/api/v2/action/workspace.promote`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handshake.daemon.authToken}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
      },
      body: JSON.stringify({
        sessionId:
          "session." +
          createHash("sha256").update(SPARK_FIXTURE_SESSION).digest("hex").slice(0, 20),
      }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    assert(
      response.ok && ((await response.json()) as { ok?: boolean }).ok,
      "Private fixture promotion failed",
    );
    return { prepared: true, lease: await publish() };
  }
  if (action === "replace-owner") {
    const before = await developmentSshAuthority(instance);
    const tmux = await tmuxAuthority();
    const ownerWitness = sparkProcessWitness(before.lease.pid, d.execution);
    assert(ownerWitness);
    await manager("down");
    assert.equal(
      sparkProcessWitness(before.lease.pid, d.execution),
      null,
      "Previous daemon is not confirmed exited",
    );
    assert.equal(
      sparkProcessWitness(tmux.record.pid, d.execution),
      tmux.witness,
      "tmux was not preserved",
    );
    await manager("up");
    const { lease } = await developmentSshAuthority(instance);
    assert.notEqual(lease.daemonId, before.lease.daemonId);
    assert.equal(sparkProcessWitness(tmux.record.pid, d.execution), tmux.witness);
    await assert.rejects(developmentSshHandshake(instance, before.lease));
    writeDevelopmentRecord(join(d.root, "lease.json"), {
      version: 1,
      instance: d.instance,
      expected: lease,
    });
    return { replaced: true, lease, tmuxPreserved: true, staleLeaseRejected: true };
  }
  const tmux = await tmuxAuthority();
  const state = action === "stamp-blocked" ? "blocked" : "done";
  await tmux.run([
    "set-option",
    "-p",
    "-t",
    `${SPARK_FIXTURE_SESSION}:0.0`,
    "@agent_state",
    `${state}:${Date.now()}`,
  ]);
  return { stamped: state };
}
