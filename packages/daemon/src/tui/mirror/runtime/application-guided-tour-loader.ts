import { createRoot, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";

/** Own asynchronous feature construction without losing the caller's Solid context. */
export function createGuidedTourLoader<Module, Integration extends { open(): void }>(options: {
  readonly load: () => Promise<Module>;
  readonly create: (module: Module) => Integration;
  readonly initialModule?: Module;
  readonly identity: () => unknown;
  readonly signal: AbortSignal;
}) {
  const owner = getOwner();
  const [integration, setIntegration] = createSignal<Integration | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let pending: Promise<void> | null = null;
  let disposed = false;
  let disposeIntegration: (() => void) | undefined;
  const dispose = () => {
    disposed = true;
    disposeIntegration?.();
    disposeIntegration = undefined;
    options.signal.removeEventListener("abort", dispose);
  };
  onCleanup(dispose);
  options.signal.addEventListener("abort", dispose, { once: true });
  if (options.signal.aborted) dispose();
  const mount = (module: Module) => {
    let cleanup: (() => void) | undefined;
    try {
      const result = runWithOwner(owner, () =>
        createRoot((stop) => {
          cleanup = stop;
          return options.create(module);
        }),
      )!;
      disposeIntegration = cleanup;
      setIntegration(() => result);
      return result;
    } catch (cause) {
      cleanup?.();
      throw cause;
    }
  };
  if (!disposed && options.initialModule !== undefined) mount(options.initialModule);
  return {
    integration,
    error,
    open(): Promise<void> {
      if (disposed) return Promise.resolve();
      const ready = integration();
      if (ready) {
        ready.open();
        return Promise.resolve();
      }
      if (pending) return pending;
      const identity = options.identity();
      setError(null);
      pending = Promise.resolve()
        .then(options.load)
        .then((module) => {
          if (disposed) return;
          if (!Object.is(identity, options.identity())) {
            setError("The machine changed while loading the walkthrough. Open it again to retry.");
            return;
          }
          mount(module).open();
        })
        .catch((cause: unknown) => {
          if (!disposed)
            setError(
              `Could not load the walkthrough: ${cause instanceof Error ? cause.message : String(cause)}. Open it again to retry.`,
            );
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
