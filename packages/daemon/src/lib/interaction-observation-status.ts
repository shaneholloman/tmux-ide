import {
  InteractionObservationStatusSchemaZ,
  type InteractionObservationStatus,
  type InteractionObservationGap,
  type TmuxServerScope,
} from "@tmux-ide/contracts";

/** Bounded latest-value state. Status wakeups never allocate receipt sequences. */
export class InteractionObservationStatusStore {
  #status: InteractionObservationStatus;
  #listeners = new Set<() => void>();
  #pending = false;
  #disposed = false;
  constructor(environmentId: string, serverScope: TmuxServerScope) {
    this.#status = InteractionObservationStatusSchemaZ.parse({
      schemaVersion: 1,
      environmentId,
      serverScope,
      method: "unavailable",
      capabilityVersion: null,
      commands: [],
      effects: [],
      coverage: "unavailable",
      cursor: null,
      lastGap: null,
      droppedCount: "0",
    });
  }
  getSnapshot(): InteractionObservationStatus {
    return structuredClone(this.#status);
  }
  subscribe(listener: () => void): () => void {
    if (this.#disposed) throw new Error("Interaction observer status is retired");
    if (this.#listeners.size >= 64)
      throw new Error("Interaction observer subscriber limit exceeded");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  setStockAvailable(available: boolean): void {
    if (this.#status.method === "native-journal") return;
    this.#update({
      ...this.#status,
      method: available ? "stock-hooks" : "unavailable",
      capabilityVersion: available ? 1 : null,
      commands: available ? ["send-keys", "capture-pane"] : [],
      effects: [],
      coverage: available ? "partial" : "unavailable",
      cursor: null,
    });
  }
  noteGap(
    reason: InteractionObservationGap["reason"],
    knownDroppedCount: number | null = null,
  ): void {
    if (
      knownDroppedCount !== null &&
      (!Number.isSafeInteger(knownDroppedCount) || knownDroppedCount < 0)
    )
      throw new TypeError("Invalid observation drop count");
    const previous = this.#status.droppedCount;
    const sum =
      previous === null || knownDroppedCount === null
        ? null
        : (BigInt(previous) + BigInt(knownDroppedCount)).toString();
    this.#update({
      ...this.#status,
      lastGap: { reason, at: new Date().toISOString(), range: null },
      droppedCount: sum !== null && BigInt(sum) > 18446744073709551615n ? null : sum,
    });
  }
  setNativeStatus(status: InteractionObservationStatus): void {
    if (status.method !== "native-journal" && status.method !== "unavailable")
      throw new Error("Invalid native observer status method");
    this.#update(status);
  }
  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
  #update(status: InteractionObservationStatus): void {
    if (this.#disposed) return;
    const parsed = InteractionObservationStatusSchemaZ.parse(status);
    if (
      parsed.environmentId !== this.#status.environmentId ||
      parsed.serverScope.serverId !== this.#status.serverScope.serverId ||
      parsed.serverScope.generation !== this.#status.serverScope.generation
    )
      throw new Error("Interaction observer scope cannot change");
    if (JSON.stringify(parsed) === JSON.stringify(this.#status)) return;
    this.#status = parsed;
    if (this.#pending) return;
    this.#pending = true;
    queueMicrotask(() => {
      this.#pending = false;
      if (this.#disposed) return;
      for (const listener of this.#listeners) {
        try {
          listener();
        } catch {
          /* observers do not own runtime */
        }
      }
    });
  }
}
