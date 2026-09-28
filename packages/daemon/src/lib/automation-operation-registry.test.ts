import { describe, expect, it, vi } from "vitest";
import { AutomationOperationRegistry } from "./automation-operation-registry.ts";

describe("automation admission and retry retention", () => {
  it("captures the admitted operation id before yielding", async () => {
    const registry = new AutomationOperationRegistry<number>();
    const handle = { ...registry.reserve("a") };
    const admittedId = handle.operationId;
    const effect = vi.fn(() => 1);
    const pending = registry.execute(handle, "a", effect);
    handle.operationId = "changed";
    await pending;
    expect(effect).toHaveBeenCalledWith(admittedId);
  });

  it("marks serialization failure unknown without retaining an active slot forever", async () => {
    let now = 0;
    const registry = new AutomationOperationRegistry<unknown>({
      capacity: 1,
      retentionMs: 1,
      now: () => now,
    });
    const handle = registry.reserve("a");
    const effect = vi.fn(() => () => undefined);
    await expect(registry.execute(handle, "a", effect)).rejects.toThrow();
    expect(registry.status(handle)).toEqual({ status: "outcome-unknown" });
    await expect(registry.execute(handle, "a", effect)).rejects.toThrow();
    expect(effect).toHaveBeenCalledTimes(1);
    now = 2;
    expect(() => registry.reserve("b")).not.toThrow();
  });
  it("runs concurrent submissions once and defensively returns the retained result", async () => {
    const registry = new AutomationOperationRegistry<{ delivered: boolean }>();
    const handle = registry.reserve("validated scope/source/intent");
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effect = vi.fn(async () => {
      await barrier;
      return { delivered: true };
    });
    const first = registry.execute(handle, "validated scope/source/intent", effect);
    const second = registry.execute(handle, "validated scope/source/intent", effect);
    expect(registry.status(handle)).toEqual({ status: "running" });
    release();
    const result = await first;
    result.delivered = false;
    expect(await second).toEqual({ delivered: true });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(registry.status(handle)).toEqual({ status: "completed", result: { delivered: true } });
  });

  it("never recreates an expired handle even after space has been reused", async () => {
    let now = 0;
    const registry = new AutomationOperationRegistry<number>({
      capacity: 1,
      retentionMs: 10,
      now: () => now,
    });
    const old = registry.reserve("a");
    const effect = vi.fn(() => 1);
    await registry.execute(old, "a", effect);
    now = 11;
    registry.reserve("b");
    await expect(registry.execute(old, "a", effect)).rejects.toThrow("unavailable");
    expect(registry.status(old)).toEqual({ status: "outcome-unknown" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("rejects prior-generation handles and arbitrary caller-minted operation ids", async () => {
    const old = new AutomationOperationRegistry<number>();
    const current = new AutomationOperationRegistry<number>();
    const handle = old.reserve("a");
    const effect = vi.fn(() => 1);
    await expect(current.execute(handle, "a", effect)).rejects.toThrow("unavailable");
    await expect(old.execute({ ...handle, operationId: "forged" }, "a", effect)).rejects.toThrow(
      "unavailable",
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it("rejects changed scope/source/payload without consuming the original reservation", async () => {
    const registry = new AutomationOperationRegistry<number>();
    const handle = registry.reserve("a");
    const effect = vi.fn(() => 1);
    await expect(registry.execute(handle, "b", effect)).rejects.toThrow("different intent");
    expect(registry.status(handle)).toEqual({ status: "reserved" });
    await registry.execute(handle, "a", effect);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("retains active work through expiry and refuses capacity before effects", async () => {
    let now = 0;
    const registry = new AutomationOperationRegistry<number>({
      capacity: 1,
      retentionMs: 1,
      now: () => now,
    });
    let release!: (value: number) => void;
    const effect = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const handle = registry.reserve("a");
    const pending = registry.execute(handle, "a", effect);
    await Promise.resolve();
    now = 100;
    expect(() => registry.reserve("b")).toThrow("capacity");
    expect(registry.status(handle)).toEqual({ status: "running" });
    release(1);
    await pending;
    await expect(registry.execute(handle, "a", effect)).rejects.toThrow("unavailable");
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("retains ambiguous failures without retrying effects", async () => {
    const registry = new AutomationOperationRegistry<number>();
    const handle = registry.reserve("a");
    const effect = vi.fn(() => {
      throw new Error("response lost after effect");
    });
    await expect(registry.execute(handle, "a", effect)).rejects.toThrow("response lost");
    await expect(registry.execute(handle, "a", effect)).rejects.toThrow("response lost");
    expect(registry.status(handle)).toEqual({ status: "outcome-unknown" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("does not start a queued effect after disposal", async () => {
    const registry = new AutomationOperationRegistry<number>();
    const handle = registry.reserve("a");
    const effect = vi.fn(() => 1);
    const pending = registry.execute(handle, "a", effect);
    registry.dispose();
    await expect(pending).rejects.toThrow("unavailable");
    expect(effect).not.toHaveBeenCalled();
    expect(() => registry.reserve("a")).toThrow("unavailable");
  });
});
