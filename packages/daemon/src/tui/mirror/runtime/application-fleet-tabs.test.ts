import { expect, it, vi } from "vitest";
import { createFleetTabs, type FleetTabTarget } from "./application-fleet-tabs.ts";
const target = (n: number): FleetTabTarget => ({
  key: `key-${n}`,
  machineId: `host-${n}`,
  liveSessionId: `session-${n}`,
  label: "same-name",
  hostLabel: `host-${n}`,
});
it("retains at most eight explicit targets and refuses an offline tab without retiring the healthy one", async () => {
  const retireActive = vi.fn(),
    open = vi.fn(async () => true);
  const owner = createFleetTabs({
    resolve: (t) => (t.machineId === "host-8" ? null : t),
    retireActive,
    open,
    publish: () => {},
    unavailable: () => {},
  });
  for (let i = 0; i < 10; i++) owner.remember(target(i));
  expect(owner.snapshot().tabs).toHaveLength(8);
  expect(await owner.activate("key-8")).toBe(false);
  expect(retireActive).not.toHaveBeenCalled();
  expect(await owner.activate("key-7")).toBe(true);
  expect(open).toHaveBeenCalledWith(target(7));
  expect(owner.snapshot().active).toBe("key-7");
  owner.close("key-9");
  expect(retireActive).toHaveBeenCalledTimes(1);
  owner.close("key-7");
  expect(retireActive).toHaveBeenCalledTimes(2);
  expect(owner.snapshot().active).toBeNull();
  owner.dispose();
});
it("cannot activate a late target after a newer activation", async () => {
  let finish!: (value: boolean) => void;
  const owner = createFleetTabs({
    resolve: (t) => t,
    retireActive: () => {},
    open: (t) =>
      t.key === "key-1"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(true),
    publish: () => {},
    unavailable: () => {},
  });
  owner.remember(target(1));
  owner.remember(target(2));
  const old = owner.activate("key-1");
  expect(await owner.activate("key-2")).toBe(true);
  finish(true);
  expect(await old).toBe(false);
  expect(owner.snapshot().active).toBe("key-2");
  owner.dispose();
});
it("contains a rejected open and fences a tab closed while opening", async () => {
  let finish!: (value: boolean) => void;
  const unavailable = vi.fn();
  const owner = createFleetTabs({
    resolve: (t) => t,
    retireActive: () => {},
    open: (t) =>
      t.key === "key-1"
        ? Promise.reject(new Error("offline"))
        : new Promise((resolve) => {
            finish = resolve;
          }),
    publish: () => {},
    unavailable,
  });
  owner.remember(target(1));
  owner.remember(target(2));
  expect(await owner.activate("key-1")).toBe(false);
  expect(unavailable).toHaveBeenCalledOnce();
  const opening = owner.activate("key-2");
  owner.close("key-2");
  finish(true);
  expect(await opening).toBe(false);
  expect(owner.snapshot().active).toBeNull();
  owner.dispose();
});

it("tracks observed background completions, acknowledges only successful opens and resets observation gaps", async () => {
  let succeed = true;
  const owner = createFleetTabs({
    resolve: (value) => value,
    retireActive() {},
    open: async () => succeed,
    publish() {},
    unavailable() {},
  });
  owner.remember(target(1));
  owner.remember(target(2));
  owner.observe(target(1).key, [{ id: "agent", activity: "complete" }]);
  expect(owner.snapshot().unread).toEqual([]);
  owner.observe(target(1).key, [{ id: "agent", activity: "running" }]);
  owner.observe(target(1).key, [{ id: "agent", activity: "complete" }]);
  expect(owner.snapshot().unread).toEqual([target(1).key]);
  succeed = false;
  await owner.activate(target(1).key);
  expect(owner.snapshot().unread).toEqual([target(1).key]);
  succeed = true;
  await owner.activate(target(1).key);
  expect(owner.snapshot().unread).toEqual([]);
  owner.remember(target(2));
  owner.observe(target(1).key, [{ id: "agent", activity: "running" }]);
  owner.observe(target(1).key, null);
  owner.observe(target(1).key, [{ id: "agent", activity: "complete" }]);
  expect(owner.snapshot().unread).toEqual([]);
  owner.observe(target(1).key, [{ id: "replacement", activity: "complete" }]);
  expect(owner.snapshot().unread).toEqual([]);
  owner.dispose();
});
