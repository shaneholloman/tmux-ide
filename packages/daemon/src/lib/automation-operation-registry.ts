import { createHash, randomUUID } from "node:crypto";
import type { AutomationOperationHandle } from "@tmux-ide/contracts";

export type AutomationOperationStatus<T> =
  | { readonly status: "reserved" | "running" }
  | { readonly status: "completed"; readonly result: T }
  | { readonly status: "outcome-unknown" };

export class AutomationOperationUnavailableError extends Error {
  constructor() {
    super("Operation is unavailable; its effect must not be repeated with a new handle");
    this.name = "AutomationOperationUnavailableError";
  }
}

interface Entry<T> {
  readonly fingerprint: string;
  readonly expiresAt: number;
  state: "reserved" | "running" | "completed" | "outcome-unknown";
  promise?: Promise<T>;
  result?: T;
}

/**
 * Admission for automation mutations, ahead of the existing semantic executor.
 * Only this authority mints handles. Missing, expired and previous-generation
 * handles never create work, including after bounded result retention evicts it.
 * Fingerprints cover canonical validated intent, resolved scope and source grant;
 * no input text is retained here. Adapters must never reserve on retry.
 */
export class AutomationOperationRegistry<T> {
  readonly #generation = randomUUID();
  readonly #entries = new Map<string, Entry<T>>();
  readonly #capacity: number;
  readonly #retentionMs: number;
  readonly #now: () => number;
  #disposed = false;

  constructor(options: { capacity?: number; retentionMs?: number; now?: () => number } = {}) {
    this.#capacity = options.capacity ?? 256;
    this.#retentionMs = options.retentionMs ?? 60_000;
    this.#now = options.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1 || this.#capacity > 4096)
      throw new RangeError("Invalid automation operation capacity");
    if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs < 1)
      throw new RangeError("Invalid automation operation retention");
  }

  reserve(canonicalIntent: string): AutomationOperationHandle {
    if (this.#disposed) throw new AutomationOperationUnavailableError();
    this.#prune();
    // Active entries are never evicted. Backpressure is explicit before effects.
    if (this.#entries.size >= this.#capacity)
      throw new Error("Automation operation capacity reached");
    const operationId = randomUUID();
    this.#entries.set(operationId, {
      fingerprint: this.#fingerprint(canonicalIntent),
      expiresAt: this.#now() + this.#retentionMs,
      state: "reserved",
    });
    return { generation: this.#generation, operationId };
  }

  execute(
    handle: AutomationOperationHandle,
    canonicalIntent: string,
    effect: (operationId: string) => Promise<T> | T,
  ): Promise<T> {
    const operationId = handle.operationId;
    const entry = this.#lookup(handle);
    if (!entry) return Promise.reject(new AutomationOperationUnavailableError());
    if (entry.fingerprint !== this.#fingerprint(canonicalIntent))
      return Promise.reject(
        new Error("Operation handle belongs to a different intent or authority"),
      );
    if (entry.promise) return entry.promise.then((result) => structuredClone(result));
    // Mark before any callback, including synchronous throws and reentrancy.
    entry.state = "running";
    entry.promise = Promise.resolve()
      .then(() => {
        if (this.#disposed) throw new AutomationOperationUnavailableError();
        return effect(operationId);
      })
      .then((result) => {
        entry.result = structuredClone(result);
        entry.state = "completed";
        return entry.result;
      })
      .catch((error: unknown) => {
        // A thrown error cannot prove that terminal input did not happen.
        entry.state = "outcome-unknown";
        throw error;
      });
    return entry.promise.then((result) => structuredClone(result));
  }

  status(handle: AutomationOperationHandle): AutomationOperationStatus<T> {
    const entry = this.#lookup(handle);
    if (!entry) return { status: "outcome-unknown" };
    if (entry.state === "completed")
      return { status: "completed", result: structuredClone(entry.result!) };
    return { status: entry.state };
  }

  dispose(): void {
    this.#disposed = true;
    this.#entries.clear();
  }

  #lookup(handle: AutomationOperationHandle): Entry<T> | undefined {
    if (this.#disposed || handle.generation !== this.#generation) return undefined;
    this.#prune();
    return this.#entries.get(handle.operationId);
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries)
      if (entry.state !== "running" && entry.expiresAt <= now) this.#entries.delete(id);
  }

  #fingerprint(intent: string): string {
    return createHash("sha256").update(intent).digest("hex");
  }
}
