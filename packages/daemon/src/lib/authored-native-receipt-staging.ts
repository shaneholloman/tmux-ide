import type { InteractionEvidence } from "@tmux-ide/contracts";
import type { InteractionReceiptJournal } from "./interaction-receipt-journal.ts";
import type { OwnedNativeInteractionDecision } from "./owned-native-interaction-bindings.ts";
import {
  canStageAuthoredNativeEvidence,
  consumeAuthoredNativeEvidence,
} from "./authored-native-receipt-enrichment.ts";
interface Pending {
  readonly decision: OwnedNativeInteractionDecision;
  readonly expiresAt: number;
}
export interface AuthoredNativeReceiptEnricherOptions {
  readonly journal: InteractionReceiptJournal;
  readonly publishRaw: (evidence: InteractionEvidence) => void;
  readonly noteGap: () => void;
  readonly onFailure: (error: unknown) => void;
  readonly maxPending?: number;
  readonly retentionMs?: number;
  readonly now?: () => number;
}
/** A bounded proof buffer driven by the existing journal's lifecycle, not another executor. */
export class AuthoredNativeReceiptEnricher {
  readonly #options: AuthoredNativeReceiptEnricherOptions;
  readonly #pending: Pending[] = [];
  readonly #unsubscribe: () => void;
  readonly #limit: number;
  readonly #retentionMs: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #deadline: number | null = null;
  #disposed = false;
  constructor(options: AuthoredNativeReceiptEnricherOptions) {
    this.#options = options;
    this.#limit = options.maxPending ?? 256;
    this.#retentionMs = options.retentionMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.#limit) ||
      this.#limit < 1 ||
      this.#limit > 4096 ||
      !Number.isSafeInteger(this.#retentionMs) ||
      this.#retentionMs < 1 ||
      this.#retentionMs > 60_000
    )
      throw new RangeError("Invalid authored evidence retention bound");
    this.#now = options.now ?? (() => performance.now());
    this.#unsubscribe = options.journal.subscribe(() => this.#safelyDrain());
  }
  get pendingCount() {
    return this.#pending.length;
  }
  consume(decision: OwnedNativeInteractionDecision): boolean {
    if (this.#disposed) return false;
    if (
      this.#pending.some(
        (item) =>
          item.decision.evidence.interactionId === decision.evidence.interactionId &&
          item.decision.evidence.revision === decision.evidence.revision,
      )
    )
      return true;
    if (consumeAuthoredNativeEvidence(this.#options.journal, decision)) return true;
    if (!decision.proof) return false;
    const receipt = this.#options.journal.latestOperationReceiptForAttempt(
      decision.proof.acknowledgement.operationId,
      decision.proof.authoredReceiptAdmissionSequence,
    );
    if (!receipt || !canStageAuthoredNativeEvidence(receipt, decision)) return false;
    if (this.#pending.length >= this.#limit) {
      this.#options.noteGap();
      return false;
    }
    this.#pending.push({
      decision: structuredClone(decision),
      expiresAt: this.#now() + this.#retentionMs,
    });
    this.#schedule();
    return true;
  }
  #safelyDrain() {
    if (this.#disposed) return;
    try {
      this.#drain();
    } catch (error) {
      this.dispose();
      this.#options.onFailure(error);
    }
  }
  #drain() {
    const now = this.#now();
    for (let index = 0; index < this.#pending.length; ) {
      const pending = this.#pending[index]!;
      const receipt = this.#options.journal.latestOperationReceiptForAttempt(
        pending.decision.proof!.acknowledgement.operationId,
        pending.decision.proof!.authoredReceiptAdmissionSequence,
      );
      if (
        receipt?.phase === "accepted" &&
        now < pending.expiresAt &&
        canStageAuthoredNativeEvidence(receipt, pending.decision)
      ) {
        index++;
        continue;
      }
      // Remove before publishing: a new journal wake must not reprocess this proof.
      this.#pending.splice(index, 1);
      if (
        receipt &&
        receipt.phase !== "accepted" &&
        consumeAuthoredNativeEvidence(this.#options.journal, pending.decision)
      )
        continue;
      this.#options.noteGap();
      this.#options.publishRaw(pending.decision.evidence);
    }
    this.#schedule();
  }
  #schedule() {
    const next = this.#pending.reduce<number | null>(
      (value, item) => (value === null ? item.expiresAt : Math.min(value, item.expiresAt)),
      null,
    );
    if (next === this.#deadline) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#deadline = next;
    if (next === null || this.#disposed) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#deadline = null;
        this.#safelyDrain();
      },
      Math.max(0, next - this.#now()),
    );
    this.#timer.unref?.();
  }
  /** Owner retirement is not publication: stop before disposing the same journal. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#deadline = null;
    this.#pending.length = 0;
  }
}
