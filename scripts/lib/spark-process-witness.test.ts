import assert from "node:assert/strict";
import { test } from "node:test";
import { sparkProcessWitness } from "./spark-process-witness.ts";
const expected = {
  bootId: "10000000-0000-4000-8000-000000000001",
  pidNamespace: "pid:[123]",
  uid: 1000,
};
const status = () => "Uid:\t1000\t1000\t1000\t1000\n";
const io = { execution: () => expected, status, identity: () => "linux:42:/private/tmux" };
const missing = () => {
  throw Object.assign(new Error("gone"), { code: "ENOENT" });
};

test("witness binds boot, namespace, UID, PID and kernel incarnation", () => {
  const a = sparkProcessWitness(12, expected, io);
  assert(a);
  assert.notEqual(a, sparkProcessWitness(13, expected, io));
  assert.notEqual(
    a,
    sparkProcessWitness(12, expected, { ...io, identity: () => "linux:43:/private/tmux" }),
  );
  assert.throws(() => sparkProcessWitness(12, expected, { ...io, status: () => "Uid: 0 0 0 0" }));
  assert.throws(() =>
    sparkProcessWitness(12, expected, {
      ...io,
      execution: () => ({ ...expected, pidNamespace: "pid:[456]" }),
    }),
  );
});
test("only confirmed absence or zombie identity is considered exited", () => {
  assert.equal(sparkProcessWitness(12, expected, { ...io, status: missing }), null);
  assert.equal(sparkProcessWitness(12, expected, { ...io, identity: () => null }), null);
  assert.throws(() => sparkProcessWitness(12, expected, { ...io, identity: missing }));
  assert.throws(() =>
    sparkProcessWitness(12, expected, {
      ...io,
      status: () => {
        throw Object.assign(new Error(), { code: "EACCES" });
      },
    }),
  );
});
test("boot change during a read invalidates both live and exited witnesses", () => {
  for (const identity of [io.identity, () => null]) {
    let reads = 0;
    assert.throws(() =>
      sparkProcessWitness(12, expected, {
        ...io,
        identity,
        execution: () =>
          reads++ === 0
            ? expected
            : { ...expected, bootId: "20000000-0000-4000-8000-000000000001" },
      }),
    );
  }
});
