/** Observer-side adapter for the fixed private Spark driver; transport owns SSH. */
import assert from "node:assert/strict";
import { z } from "zod";
import type { CanonicalSshSecondary } from "./owned-ssh-secondary.ts";

export type SparkRemoteSecondaryAction =
  | "secondary-start"
  | "secondary-bind-registration"
  | "secondary-seed"
  | "secondary-retire";
const decimal = z.string().regex(/^[0-9]+$/u);
const positiveDecimal = z.string().regex(/^[1-9][0-9]*$/u);
const safeInteger = z.number().int().nonnegative().safe();
const liveReceipt = z
  .object({
    socket: z.string(),
    proof: z
      .object({
        socket: z
          .object({
            path: z.string(),
            dev: safeInteger,
            ino: safeInteger,
            mtimeNs: decimal,
            birthtimeNs: decimal,
          })
          .strict(),
        pid: positiveDecimal,
        startTime: positiveDecimal,
        witness: z.string().min(1).max(8192),
      })
      .strict(),
  })
  .strict();
const witnessSchema = z
  .object({
    bootId: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
    pidNamespace: z.string().regex(/^pid:\[\d+\]$/u),
    uid: z.number().int().positive().safe(),
    pid: z.number().int().positive().safe(),
    identity: z.string(),
  })
  .strict();

export function createSparkRemoteSecondary(options: {
  root: string;
  /** Returns the parsed private receipt's result, never stdout or the envelope. */
  runAction(action: SparkRemoteSecondaryAction, serverId?: string): Promise<unknown>;
}): CanonicalSshSecondary {
  assert(/^\/tmp\/tia-ssh-[a-f0-9]{32}$/u.test(options.root), "Invalid private Spark root");
  const socket = `${options.root}/secondary.sock`;
  let attempted = false;
  let retired = false;
  let bound = false;
  let bindingAttempted = false;
  let busy = false;
  let admitted: z.infer<typeof liveReceipt> | undefined;
  const run = async (action: SparkRemoteSecondaryAction, serverId?: string) => {
    assert(!busy, "Secondary action already in progress");
    busy = true;
    try {
      return await options.runAction(action, serverId);
    } finally {
      busy = false;
    }
  };
  const validateLive = (result: unknown) => {
    const receipt = liveReceipt.parse(result);
    assert.equal(receipt.socket, socket, "Secondary socket escaped private root");
    assert.equal(receipt.proof.socket.path, socket, "Secondary proof socket mismatch");
    assert(Number.isSafeInteger(Number(receipt.proof.pid)));
    const witness = witnessSchema.parse(JSON.parse(receipt.proof.witness));
    assert.equal(witness.pid, Number(receipt.proof.pid), "Secondary witness PID mismatch");
    const native = `${options.root}/source/packages/daemon/dist/native/tmux/linux-arm64/tmux`;
    assert(/^linux:[0-9]+:/u.test(witness.identity), "Invalid Linux process witness");
    assert.equal(
      witness.identity.replace(/^linux:[0-9]+:/u, ""),
      native,
      "Secondary witness executable mismatch",
    );
    return receipt;
  };
  return {
    retainedRoot: options.root,
    async start(semanticPaneId) {
      assert.equal(semanticPaneId, "pane.shared", "Spark secondary uses the fixed semantic pane");
      assert(!attempted && !retired && !busy, "Secondary already attempted or retired");
      attempted = true;
      admitted = validateLive(await run("secondary-start"));
      return { socket: admitted.socket };
    },
    async registered(serverId) {
      assert(
        admitted && !retired && !bindingAttempted && !busy,
        "Secondary cannot bind registration",
      );
      assert(/^tmux-server\.[a-f0-9]{32}$/u.test(serverId), "Invalid secondary registration ID");
      bindingAttempted = true;
      z.object({ bound: z.literal(true) })
        .strict()
        .parse(await run("secondary-bind-registration", serverId));
      bound = true;
    },
    async seed() {
      assert(admitted && bound && !retired, "Secondary registration is not admitted");
      assert.deepEqual(
        validateLive(await run("secondary-seed")),
        admitted,
        "Secondary proof changed",
      );
    },
    async retire() {
      assert(!busy, "Secondary action already in progress");
      if (retired) return;
      z.object({ retired: z.literal(true) })
        .strict()
        .parse(await run("secondary-retire"));
      retired = true;
    },
    removeFiles() {
      assert(retired && !busy, "Secondary retirement must be verified before file removal");
      // The outer managed cleanup owns remote records and the task root.
    },
  };
}
