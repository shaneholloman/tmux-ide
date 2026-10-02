import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForTerminfoProcessExit } from "./terminfo-exit-proof.ts";

function clock() {
  let elapsed = 0;
  const waits: number[] = [];
  return {
    now: () => elapsed,
    wait: async (milliseconds: number) => {
      waits.push(milliseconds);
      elapsed += milliseconds;
    },
    advance: (milliseconds: number) => {
      elapsed += milliseconds;
    },
    waits,
  };
}
const missing = () => {
  throw Object.assign(new Error("transient missing proc file"), { code: "ENOENT" });
};

test("transient missing file and live witness still require a later confirmed exit", async () => {
  const time = clock();
  let calls = 0;
  await waitForTerminfoProcessExit(
    (pid) => {
      assert.equal(pid, 42);
      calls += 1;
      if (calls === 1) return missing();
      return calls === 2 ? "same-live-incarnation" : null;
    },
    42,
    time,
  );
  assert.equal(calls, 3);
  assert.deepEqual(time.waits, [20, 20]);
});
test("persistent missing files exhaust the original five-second deadline", async () => {
  const time = clock();
  let calls = 0;
  await assert.rejects(
    waitForTerminfoProcessExit(
      () => {
        calls += 1;
        return missing();
      },
      42,
      time,
    ),
    /exit unproven at deadline/,
  );
  assert.equal(time.now(), 5_000);
  assert.equal(calls, 250);
});
test("permission errors remain immediate refusals with no retry", async () => {
  const time = clock();
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  await assert.rejects(
    waitForTerminfoProcessExit(
      () => {
        throw denied;
      },
      42,
      time,
    ),
    (error) => error === denied,
  );
  assert.deepEqual(time.waits, []);
});
test("a slow read cannot extend the absolute deadline even if it eventually reports exit", async () => {
  const time = clock();
  await assert.rejects(
    waitForTerminfoProcessExit(
      () => {
        time.advance(5_001);
        return null;
      },
      42,
      time,
    ),
    /exit unproven at deadline/,
  );
  assert.deepEqual(time.waits, []);
});
