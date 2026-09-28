import { describe, expect, it, vi } from "vitest";
import { InteractionObservationStatusStore } from "./interaction-observation-status.ts";
const scope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "11111111-1111-4111-8111-111111111111",
};
const create = () =>
  new InteractionObservationStatusStore("00000000-0000-4000-8000-000000000001", scope);
describe("interaction observation status", () => {
  it("starts unavailable and reports only actual partial stock capability", async () => {
    const store = create();
    const callback = vi.fn();
    store.subscribe(callback);
    expect(store.getSnapshot().coverage).toBe("unavailable");
    store.setStockAvailable(true);
    store.noteGap("unresolved-target", 1);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      method: "stock-hooks",
      coverage: "partial",
      effects: [],
      droppedCount: "1",
      lastGap: { reason: "unresolved-target" },
    });
    store.noteGap("uncertain-consume");
    store.noteGap("unresolved-target", 1);
    expect(store.getSnapshot().droppedCount).toBeNull();
  });
  it("copies state, fences scope, bounds subscriptions and cancels queued disposal notifications", async () => {
    const store = create();
    const callback = vi.fn();
    store.subscribe(callback);
    const snapshot = store.getSnapshot();
    snapshot.serverScope.generation = "22222222-2222-4222-8222-222222222222";
    expect(() => store.setNativeStatus(snapshot)).toThrow("scope");
    for (let i = 0; i < 63; i++) store.subscribe(() => {});
    expect(() => store.subscribe(() => {})).toThrow("limit");
    store.setStockAvailable(true);
    store.dispose();
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();
    expect(() => store.subscribe(() => {})).toThrow("retired");
  });
  it("does not downgrade selected native capability from stock callbacks", () => {
    const store = create();
    store.setNativeStatus({
      ...store.getSnapshot(),
      method: "native-journal",
      capabilityVersion: 1,
      commands: ["send-keys"],
      effects: ["input-enqueued"],
      coverage: "declared-capabilities",
    });
    store.setStockAvailable(false);
    expect(store.getSnapshot().method).toBe("native-journal");
    store.setNativeStatus({ ...store.getSnapshot(), droppedCount: "18446744073709551615" });
    store.noteGap("unresolved-target", 1);
    expect(store.getSnapshot().droppedCount).toBeNull();
  });
});
