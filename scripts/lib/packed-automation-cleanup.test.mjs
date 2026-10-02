import assert from "node:assert/strict";
import { test } from "node:test";
import { settleAutomationResources } from "./packed-automation-cleanup.mjs";

test("a stalled subscription cannot prevent TERM, escalation, and child reaping", async () => {
  const signals = [];
  let reaped;
  const done = new Promise((resolve) => {
    reaped = resolve;
  });
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        this.signalCode = signal;
        reaped();
      }
    },
  };
  let closed = false;
  const subscription = {
    close() {
      closed = true;
    },
    done: new Promise(() => {}),
  };
  await assert.rejects(
    settleAutomationResources(
      { children: new Map([[child, done]]), subscriptions: new Set([subscription]) },
      { graceMs: 5, killMs: 100, streamMs: 10 },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /streams did not settle/);
      return true;
    },
  );
  assert.equal(closed, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(child.signalCode, "SIGKILL");
});

test("close and settlement failures remain visible after every retained child settles", async () => {
  const order = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      order.push(signal);
      this.signalCode = signal;
    },
  };
  const closeError = new Error("close failure");
  const settlementError = new Error("stream failure");
  const subscription = {
    close() {
      order.push("close");
      throw closeError;
    },
    done: Promise.reject(settlementError),
  };
  await assert.rejects(
    settleAutomationResources({
      children: new Map([[child, Promise.resolve()]]),
      subscriptions: new Set([subscription]),
    }),
    (error) => {
      assert.deepEqual(error.errors, [closeError, settlementError]);
      return true;
    },
  );
  assert.deepEqual(order, ["SIGTERM", "close"]);
});

test("a child that never closes after KILL produces a bounded failure", async () => {
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
    },
  };
  await assert.rejects(
    settleAutomationResources(
      { children: new Map([[child, new Promise(() => {})]]), subscriptions: new Set() },
      { graceMs: 5, killMs: 5 },
    ),
    /cleanup incomplete/,
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
