/** Private Linux qualification fixture. Caller must complete driver runtime preflight. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { z } from "zod";
import { fenceNativeTmuxCommand } from "../../packages/daemon/src/lib/tmux-server-generation-runner.ts";
import { createTmuxServerProbe } from "../../packages/daemon/src/lib/tmux-server-registration.ts";
import {
  captureUnixSocketIdentity,
  revalidateUnixSocketIdentity,
} from "../../packages/daemon/src/lib/unix-socket-authority.ts";
import { tmuxClientEnvironment } from "../../packages/daemon/src/lib/tmux-client-execution.ts";
import { sparkProcessWitness, type SparkExecutionIdentity } from "./spark-process-witness.ts";

const integer = z.number().int().nonnegative().safe();
const decimal = z.string().regex(/^[0-9]+$/u);
const Proof = z
  .object({
    socket: z
      .object({
        path: z.string(),
        dev: integer,
        ino: integer,
        mtimeNs: decimal,
        birthtimeNs: decimal,
      })
      .strict(),
    pid: z.string().regex(/^[1-9][0-9]*$/u),
    startTime: z.string().regex(/^[1-9][0-9]*$/u),
    witness: z.string().min(1).max(8192),
  })
  .strict();
const State = z
  .object({
    version: z.literal(1),
    nonce: z.string(),
    phase: z.enum(["attempted", "live", "retiring", "retired"]),
    proof: Proof.optional(),
  })
  .strict();
type ProofValue = z.infer<typeof Proof>;
export interface SparkSecondaryDescriptor {
  root: string;
  nonce: string;
  execution: SparkExecutionIdentity;
  tools: { native: { path: string } };
}
export type SparkSecondaryAction =
  | "secondary-start"
  | "secondary-seed"
  | "secondary-probe"
  | "secondary-retire";
interface IO {
  run(args: string[]): Promise<string>;
  observe: ReturnType<typeof createTmuxServerProbe>;
  witness(pid: number): string | null;
  capture: typeof captureUnixSocketIdentity;
  revalidate: typeof revalidateUnixSocketIdentity;
  sleep(): Promise<void>;
}
function absent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Fixed actions only; no caller-selected session, command, socket or marker. */
export async function sparkSecondaryAction(
  descriptor: SparkSecondaryDescriptor,
  action: SparkSecondaryAction,
  testIO?: IO,
) {
  assert(
    ["secondary-start", "secondary-seed", "secondary-probe", "secondary-retire"].includes(action),
  );
  assert(/^[a-f0-9]{32}$/u.test(descriptor.nonce));
  assert.equal(descriptor.root, `/tmp/tia-ssh-${descriptor.nonce}`);
  const root = lstatSync(descriptor.root);
  assert(
    root.isDirectory() && root.uid === descriptor.execution.uid && (root.mode & 0o777) === 0o700,
  );
  assert.equal(realpathSync(descriptor.root), descriptor.root);
  const socket = `${descriptor.root}/secondary.sock`;
  const path = `${descriptor.root}/secondary.json`;
  const lock = `${descriptor.root}/secondary.lock`;
  const execute = promisify(execFile);
  const io: IO = testIO ?? {
    run: async (args) =>
      (
        await execute(
          descriptor.tools.native.path,
          ["-u", "-S", socket, "-f", "/dev/null", ...args],
          {
            env: tmuxClientEnvironment(process.env),
            encoding: "utf8",
            timeout: 5000,
            killSignal: "SIGKILL",
            maxBuffer: 65536,
          },
        )
      ).stdout.trim(),
    observe: createTmuxServerProbe(descriptor.tools.native.path),
    witness: (pid) => sparkProcessWitness(pid, descriptor.execution),
    capture: captureUnixSocketIdentity,
    revalidate: revalidateUnixSocketIdentity,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 25)),
  };
  // A crashed action leaves this lock: never guess whether its mutation completed.
  const lockFd = openSync(
    lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(lockFd);
  try {
    const read = () => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        assert(
          stat.isFile() &&
            stat.nlink === 1 &&
            stat.uid === descriptor.execution.uid &&
            (stat.mode & 0o777) === 0o600 &&
            stat.size > 0 &&
            stat.size <= 16384,
        );
        const bytes = Buffer.alloc(stat.size + 1);
        const size = readSync(fd, bytes, 0, bytes.length, 0);
        assert.equal(size, stat.size);
        const state = State.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
        const after = fstatSync(fd);
        for (const key of ["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)
          assert.equal(stat[key], after[key]);
        assert.equal(state.nonce, descriptor.nonce);
        if (state.proof) assert.equal(state.proof.socket.path, socket);
        if (state.phase !== "attempted") assert(state.proof);
        return state;
      } finally {
        closeSync(fd);
      }
    };
    const write = (phase: z.infer<typeof State>["phase"], proof?: ProofValue) => {
      const next = State.parse({
        version: 1,
        nonce: descriptor.nonce,
        phase,
        ...(proof ? { proof } : {}),
      });
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    };
    const socketIdentity = (proof: ProofValue) => ({
      ...proof.socket,
      mtimeNs: BigInt(proof.socket.mtimeNs),
      birthtimeNs: BigInt(proof.socket.birthtimeNs),
    });
    const verify = async (proof: ProofValue) => {
      io.revalidate(socketIdentity(proof));
      assert.equal(
        io.witness(Number(proof.pid)),
        proof.witness,
        "Secondary process incarnation changed",
      );
      const observed = await io.observe({ kind: "path", path: socket });
      assert(observed?.valid());
      assert.deepEqual(observed.nativeServerIdentity, {
        pid: proof.pid,
        startTime: proof.startTime,
      });
      io.revalidate(socketIdentity(proof));
      assert.equal(
        io.witness(Number(proof.pid)),
        proof.witness,
        "Secondary process incarnation changed",
      );
    };
    const mutate = async (proof: ProofValue, args: string[]) => {
      await verify(proof);
      const command = fenceNativeTmuxCommand(["-N", ...args], {
        pid: proof.pid,
        startTime: proof.startTime,
      });
      return command.verify(await io.run(command.argv));
    };
    const target = "attribution-collision:0.0";
    if (action === "secondary-start") {
      assert(absent(path) && absent(socket), "Secondary already attempted or socket exists");
      write("attempted");
      await io.run(["new-session", "-d", "-s", "attribution-collision", "/bin/cat"]);
      const identity = io.capture(socket);
      const observed = await io.observe({ kind: "path", path: socket });
      assert(observed?.nativeServerIdentity && observed.valid());
      const witness = io.witness(Number(observed.nativeServerIdentity.pid));
      assert(witness, "Secondary has no admitted process witness");
      const proof = Proof.parse({
        socket: {
          ...identity,
          mtimeNs: String(identity.mtimeNs),
          birthtimeNs: String(identity.birthtimeNs),
        },
        ...observed.nativeServerIdentity,
        witness,
      });
      await verify(proof);
      // Save the admitted ownership before stamping, so partial stamping is retireable.
      write("live", proof);
      await mutate(proof, ["set-option", "-p", "-t", target, "@tmux_ide_pane_id", "pane.shared"]);
      await mutate(proof, ["set-option", "-p", "-t", target, "@agent_state", `idle:${Date.now()}`]);
      return { socket, proof };
    }
    if (action === "secondary-retire" && absent(path)) {
      assert(absent(socket), "Unknown secondary socket retained");
      return { retired: true };
    }
    const state = read();
    assert(state.proof, "Secondary creation outcome has no admitted witness");
    const proof = state.proof;
    if (action === "secondary-retire") {
      if (state.phase !== "retired" && state.phase !== "retiring") {
        await verify(proof);
        write("retiring", proof);
        assert.equal(await mutate(proof, ["kill-server"]), "");
      }
      const deadline = Date.now() + 3000;
      while (io.witness(Number(proof.pid)) !== null) {
        assert(Date.now() < deadline, "Secondary exit unproven; state retained");
        await io.sleep();
      }
      assert(absent(socket), "Secondary socket persists; state retained");
      write("retired", proof);
      return { retired: true };
    }
    assert.equal(state.phase, "live", "Secondary is not live");
    await verify(proof);
    if (action === "secondary-seed") {
      await mutate(proof, ["send-keys", "-t", target, "-l", "owned-secondary-marker"]);
      await mutate(proof, ["send-keys", "-t", target, "Enter"]);
    }
    return { socket, proof };
  } finally {
    unlinkSync(lock);
  }
}
