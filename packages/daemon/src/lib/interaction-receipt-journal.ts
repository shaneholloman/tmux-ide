import { InteractionReceiptSchemaZ, type InteractionReceipt } from "@tmux-ide/contracts";

export type InteractionReceiptDraft = Omit<InteractionReceipt, "type" | "sequence">;
export interface InteractionReceiptReplay {
  readonly cursor: number;
  readonly gap: { readonly from: number; readonly through: number } | null;
  readonly receipts: readonly InteractionReceipt[];
}

/** One owner's bounded receipt history. Its cursor is NOT the global resource clock. */
export class InteractionReceiptJournal {
  readonly #capacity: number;
  readonly #receipts: InteractionReceipt[] = [];
  readonly #listeners = new Set<() => void>();
  #sequence = 0;
  #disposed = false;
  #wakeScheduled = false;

  constructor(capacity = 256) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096)
      throw new RangeError("Receipt journal capacity must be between 1 and 4096");
    this.#capacity = capacity;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("Receipt journal owner is retired");
  }

  publish(draft: InteractionReceiptDraft): InteractionReceipt {
    this.#assertOpen();
    if (!Number.isSafeInteger(this.#sequence + 1)) throw new Error("Receipt cursor exhausted");
    const receipt = InteractionReceiptSchemaZ.parse({
      ...draft,
      type: "interaction.receipt",
      sequence: this.#sequence + 1,
    });
    this.#sequence = receipt.sequence;
    this.#receipts.push(receipt);
    if (this.#receipts.length > this.#capacity) this.#receipts.shift();
    this.#scheduleWake();
    return structuredClone(receipt);
  }

  #scheduleWake(): void {
    if (this.#wakeScheduled) return;
    this.#wakeScheduled = true;
    // Signal only, coalesced across a burst, off the mutation's call stack.
    // Readers retain one cursor, not a queue of copied event payloads.
    queueMicrotask(() => {
      this.#wakeScheduled = false;
      for (const listener of [...this.#listeners]) {
        if (!this.#listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          this.#listeners.delete(listener);
        }
      }
      if (this.#disposed) this.#listeners.clear();
    });
  }

  read(after: number): InteractionReceiptReplay {
    this.#assertOpen();
    if (!Number.isSafeInteger(after) || after < 0 || after > this.#sequence)
      throw new RangeError("Invalid owner receipt cursor");
    const oldest = this.#receipts[0]?.sequence ?? this.#sequence + 1;
    return {
      cursor: this.#sequence,
      gap: after + 1 < oldest ? { from: after + 1, through: oldest - 1 } : null,
      receipts: this.#receipts
        .filter((receipt) => receipt.sequence > after)
        .map((receipt) => structuredClone(receipt)),
    };
  }

  /** Subscribe before taking the initial snapshot to avoid a readiness gap. */
  subscribe(wake: () => void): () => void {
    this.#assertOpen();
    if (this.#listeners.size >= 64 && !this.#listeners.has(wake))
      throw new Error("Receipt subscriber capacity reached");
    this.#listeners.add(wake);
    return () => {
      this.#listeners.delete(wake);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Wake idle transports so they close when read() reports retirement.
    this.#scheduleWake();
    this.#receipts.length = 0;
  }
}
