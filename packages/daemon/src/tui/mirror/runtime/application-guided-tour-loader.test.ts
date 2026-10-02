import {
  createContext,
  createRoot,
  createSignal,
  createComputed,
  onCleanup,
  useContext,
} from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createGuidedTourLoader } from "./application-guided-tour-loader.ts";
import {
  prepareApplicationGuidedTour,
  type GuidedTourIntegrationModule,
} from "./application-guided-tour-preparation.ts";
import { guidedTourLabel, initialGuidedTourState } from "./guided-tour.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(load: () => Promise<string>, initialModule?: string) {
  const controller = new AbortController();
  const open = vi.fn();
  const cleanup = vi.fn();
  let identity = 1;
  const create = vi.fn(() => {
    onCleanup(cleanup);
    return { open };
  });
  const root = createRoot((dispose) => ({
    dispose,
    loader: createGuidedTourLoader({
      load,
      create,
      initialModule,
      identity: () => identity,
      signal: controller.signal,
    }),
  }));
  return {
    ...root,
    controller,
    open,
    cleanup,
    create,
    replace: () => {
      identity++;
    },
  };
}

describe("guided tour admission", () => {
  it.each(["welcome", "practice", "complete"] as const)(
    "retains %s label without loading inactive integration",
    async (step) => {
      const state = { ...initialGuidedTourState(), step };
      const read = vi.fn(() => state);
      const load = vi.fn<() => Promise<GuidedTourIntegrationModule>>();
      const preparation = await prepareApplicationGuidedTour(read, load);
      expect(preparation).toEqual({ state });
      expect(read).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalled();
      expect(guidedTourLabel(preparation.state)).toBe(
        step === "welcome"
          ? "Learn tmux-ide"
          : step === "complete"
            ? "Replay walkthrough"
            : "Resume walkthrough",
      );
    },
  );

  it("awaits the saved active module before mount preparation completes", async () => {
    const module = {} as GuidedTourIntegrationModule;
    const pending = deferred<GuidedTourIntegrationModule>();
    const state = { ...initialGuidedTourState(), active: true };
    let complete = false;
    const preparing = prepareApplicationGuidedTour(
      () => state,
      () => pending.promise,
    ).then((value) => {
      complete = true;
      return value;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    pending.resolve(module);
    expect(await preparing).toEqual({ state, module });
  });

  it("constructs saved active integration synchronously without an artificial open event", () => {
    const load = vi.fn<() => Promise<string>>();
    const fixture = setup(load, "prepared");
    try {
      expect(fixture.create).toHaveBeenCalledExactlyOnceWith("prepared");
      expect(fixture.loader.integration()).not.toBeNull();
      expect(load).not.toHaveBeenCalled();
      expect(fixture.open).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
    expect(fixture.cleanup).toHaveBeenCalledTimes(1);
  });

  it("leaves inactive integration unconstructed, then coalesces open intent exactly once", async () => {
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);
    const fixture = setup(load);
    try {
      expect(load).not.toHaveBeenCalled();
      expect(fixture.create).not.toHaveBeenCalled();
      const first = fixture.loader.open();
      expect(fixture.loader.open()).toBe(first);
      await Promise.resolve();
      expect(load).toHaveBeenCalledTimes(1);
      pending.resolve("module");
      await first;
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.open).toHaveBeenCalledTimes(1);
      await fixture.loader.open();
      expect(load).toHaveBeenCalledTimes(1);
      expect(fixture.open).toHaveBeenCalledTimes(2);
    } finally {
      fixture.dispose();
    }
  });

  it.each(["dispose", "abort"] as const)("rejects late construction after %s", async (action) => {
    const pending = deferred<string>();
    const fixture = setup(() => pending.promise);
    const opening = fixture.loader.open();
    if (action === "dispose") fixture.dispose();
    else fixture.controller.abort();
    pending.resolve("module");
    await opening;
    expect(fixture.create).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.loader.integration()).toBeNull();
    fixture.dispose();
  });

  it("drops an intent across authority replacement and allows a new explicit request", async () => {
    const pending = deferred<string>();
    const fixture = setup(() => pending.promise);
    try {
      const opening = fixture.loader.open();
      fixture.replace();
      pending.resolve("module");
      await opening;
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.loader.error()).toContain("machine changed");
      await fixture.loader.open();
      expect(fixture.create).toHaveBeenCalledTimes(1);
      expect(fixture.open).toHaveBeenCalledTimes(1);
      expect(fixture.loader.error()).toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("exposes a load failure without writing tour state and retries on the next open", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce("module");
    const fixture = setup(load);
    try {
      await fixture.loader.open();
      expect(fixture.loader.error()).toContain("unavailable");
      expect(fixture.create).not.toHaveBeenCalled();
      expect(fixture.open).not.toHaveBeenCalled();
      await fixture.loader.open();
      expect(load).toHaveBeenCalledTimes(2);
      expect(fixture.loader.error()).toBeNull();
      expect(fixture.open).toHaveBeenCalledTimes(1);
    } finally {
      fixture.dispose();
    }
  });

  it("disposes a failed construction once and retries without publishing or opening it", async () => {
    const failedCleanup = vi.fn();
    const successfulCleanup = vi.fn();
    const open = vi.fn();
    const create = vi
      .fn()
      .mockImplementationOnce(() => {
        onCleanup(failedCleanup);
        throw new Error("construction failed");
      })
      .mockImplementationOnce(() => {
        onCleanup(successfulCleanup);
        return { open };
      });
    const { loader, dispose } = createRoot((dispose) => ({
      dispose,
      loader: createGuidedTourLoader({
        load: async () => "module",
        create,
        identity: () => 1,
        signal: new AbortController().signal,
      }),
    }));
    try {
      await loader.open();
      expect(failedCleanup).toHaveBeenCalledTimes(1);
      expect(loader.integration()).toBeNull();
      expect(loader.error()).toContain("construction failed");
      expect(open).not.toHaveBeenCalled();
      await loader.open();
      expect(create).toHaveBeenCalledTimes(2);
      expect(loader.integration()).not.toBeNull();
      expect(open).toHaveBeenCalledTimes(1);
      expect(failedCleanup).toHaveBeenCalledTimes(1);
      expect(successfulCleanup).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
    expect(failedCleanup).toHaveBeenCalledTimes(1);
    expect(successfulCleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves a ready open's synchronous exception without stranding subsequent opens", async () => {
    const open = vi.fn().mockImplementationOnce(() => {
      throw new Error("open failed");
    });
    const load = vi.fn(async () => "module");
    const { loader, dispose } = createRoot((dispose) => ({
      dispose,
      loader: createGuidedTourLoader({
        load,
        create: () => ({ open }),
        initialModule: "prepared",
        identity: () => 1,
        signal: new AbortController().signal,
      }),
    }));
    try {
      expect(() => loader.open()).toThrow("open failed");
      await loader.open();
      expect(open).toHaveBeenCalledTimes(2);
      expect(load).not.toHaveBeenCalled();
      expect(loader.integration()).not.toBeNull();
    } finally {
      dispose();
    }
  });

  it("restores Solid context and disposes reactive work created after the await", async () => {
    const Context = createContext("missing");
    const pending = deferred<string>();
    const controller = new AbortController();
    const cleanup = vi.fn();
    const seen: number[] = [];
    let inherited = "";
    const [value, setValue] = createSignal(0);
    let loader!: ReturnType<typeof createGuidedTourLoader<string, { open(): void }>>;
    const dispose = createRoot((stop) => {
      Context.Provider({
        value: "parent",
        get children() {
          loader = createGuidedTourLoader({
            load: () => pending.promise,
            identity: () => 1,
            signal: controller.signal,
            create: () => {
              inherited = useContext(Context);
              onCleanup(cleanup);
              createComputed(() => {
                seen.push(value());
              });
              return { open() {} };
            },
          });
          return null;
        },
      });
      return stop;
    });
    try {
      const opening = loader.open();
      pending.resolve("module");
      await opening;
      expect(inherited).toBe("parent");
      setValue(1);
      expect(seen).toEqual([0, 1]);
      controller.abort();
      setValue(2);
      expect(seen).toEqual([0, 1]);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
