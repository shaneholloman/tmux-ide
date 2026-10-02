import type {
  InteractionReceiptDraft,
  InteractionReceiptJournal,
} from "./interaction-receipt-journal.ts";
/** Owner admission is keyed by this journal's cursor, never a notification stream's clock. */
export function publishOwnerInteractionReceipt(
  journal: InteractionReceiptJournal,
  draft: InteractionReceiptDraft,
  notify: (draft: InteractionReceiptDraft) => unknown,
) {
  const retained = journal.publish(draft);
  notify(draft);
  return retained;
}
