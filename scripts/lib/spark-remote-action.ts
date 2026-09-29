/** Observer-only closed transport for the private Spark driver. Never retries mutations. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix } from "node:path";
import { z } from "zod";
import { SPARK_DRIVER_ACTIONS, sparkDriverAction } from "./spark-driver-descriptor.mjs";

const RECEIPT_LIMIT = 1024 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const absolute = (value: string) => {
  assert(
    typeof value === "string" &&
      value.startsWith("/") &&
      value.length <= 4096 &&
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }) &&
      posix.normalize(value) === value,
    "Invalid Spark transport path",
  );
  return value;
};
// Pinned Node reads only the generated basename beneath the private task root.
// stdout is private data consumed by the caller; it is never forwarded to logs.
const READ_RECEIPT = `
const fs = require('node:fs');
const assert = require('node:assert/strict');
const [root, name] = process.argv.slice(1);
assert(/^\\/tmp\\/tia-ssh-[a-f0-9]{32}$/.test(root));
assert(/^receipt-[a-z-]+-[a-f0-9-]{36}\\.json$/.test(name));
assert.equal(fs.realpathSync(root), root);
const owner = fs.lstatSync(root);
assert(owner.isDirectory() && owner.uid === process.getuid() && (owner.mode & 511) === 448);
const fd = fs.openSync(root + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
try {
  const before = fs.fstatSync(fd);
  assert(before.isFile() && before.nlink === 1 && before.uid === process.getuid() && (before.mode & 511) === 384 && before.size > 0 && before.size <= ${RECEIPT_LIMIT});
  const bytes = Buffer.alloc(before.size + 1);
  const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
  assert.equal(size, before.size);
  const after = fs.fstatSync(fd);
  for (const key of ['dev','ino','size','mtimeMs','ctimeMs']) assert.equal(before[key], after[key]);
  process.stdout.write(bytes.subarray(0, size));
} finally { fs.closeSync(fd); }
`;
export interface SparkRemoteExecOptions {
  encoding: "utf8";
  timeout: number;
  killSignal: "SIGKILL";
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}
export type SparkRemoteExec = (
  file: string,
  args: string[],
  options: SparkRemoteExecOptions,
) => Promise<{ stdout: string; stderr?: string }>;

export function createSparkRemoteAction(
  options: {
    root: string;
    node: string;
    /** Exact reviewed SSH alias or user@host, interpreted through this private config. */
    target: string;
    config: string;
  },
  injectedExec?: SparkRemoteExec,
) {
  options = { ...options };
  assert(/^\/tmp\/tia-ssh-[a-f0-9]{32}$/u.test(options.root), "Invalid Spark task root");
  absolute(options.node);
  absolute(options.config);
  assert(
    /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(
      options.target,
    ),
    "Invalid Spark SSH target",
  );
  const execute: SparkRemoteExec = injectedExec ?? promisify(execFile);
  const descriptor = `${options.root}/driver.json`;
  const driver = `${options.root}/source/scripts/spark-qualification-driver.mjs`;
  const prefix = [
    "-F",
    options.config,
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForkAfterAuthentication=no",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "--",
    options.target,
  ];
  const command = (args: string[]) =>
    ["/usr/bin/env", "-i", `HOME=${options.root}`, "PATH=/usr/bin:/bin", options.node, ...args]
      .map(quote)
      .join(" ");
  const invoke = async (args: string[], timeout: number, maxBuffer: number) =>
    execute("/usr/bin/ssh", [...prefix, command(args)], {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer,
      env: { PATH: "/usr/bin:/bin", ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
    });
  let busy = false;
  return async function runAction(action: string, serverId?: string): Promise<unknown> {
    assert(SPARK_DRIVER_ACTIONS.includes(action), "Unknown Spark action");
    const actionArgs = [descriptor, action, ...(serverId === undefined ? [] : [serverId])];
    sparkDriverAction(actionArgs);
    assert(!busy, "Spark action already in progress");
    busy = true;
    try {
      const timeout =
        action === "prepare"
          ? 300_000
          : action === "replace-owner" || action === "cleanup"
            ? 120_000
            : 30_000;
      const output = await invoke([driver, ...actionArgs], timeout, 8192);
      const envelope = z
        .object({ ok: z.literal(true), receipt: z.string() })
        .strict()
        .parse(JSON.parse(output.stdout));
      const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
      assert(
        new RegExp(`^receipt-${action}-${uuid}\\.json$`, "u").test(envelope.receipt),
        "Unexpected Spark receipt basename",
      );
      const receiptOutput = await invoke(
        ["-e", READ_RECEIPT, options.root, envelope.receipt],
        15_000,
        RECEIPT_LIMIT,
      );
      assert(Buffer.byteLength(receiptOutput.stdout) <= RECEIPT_LIMIT);
      const receipt = z
        .object({ version: z.literal(1), action: z.literal(action), result: z.unknown() })
        .strict()
        .parse(JSON.parse(receiptOutput.stdout));
      assert(Object.hasOwn(receipt, "result"), "Missing Spark receipt result");
      return receipt.result;
    } catch {
      // exec errors can embed private receipts, auth material and remote logs.
      throw new Error(
        "Private Spark action outcome is unconfirmed; retain task records and do not rerun automatically",
      );
    } finally {
      busy = false;
    }
  };
}
