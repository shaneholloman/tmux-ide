import { z } from "zod";
import { InteractionEvidenceSchemaZ } from "./interaction-evidence.ts";
import { InteractionReceiptSchemaZ } from "./interaction-receipts.ts";

/** Native observations have no invented semantic target or authored operation outcome. */
export const InteractionEvidenceRecordSchemaZ = z
  .object({
    type: z.literal("interaction.evidence"),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    evidence: InteractionEvidenceSchemaZ,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.evidence.observation.kind !== "native-journal")
      ctx.addIssue({ code: "custom", message: "Evidence-only records require native observation" });
  });
export const InteractionJournalEntrySchemaZ = z.union([
  InteractionReceiptSchemaZ,
  InteractionEvidenceRecordSchemaZ,
]);
export type InteractionEvidenceRecord = z.infer<typeof InteractionEvidenceRecordSchemaZ>;
export type InteractionJournalEntry = z.infer<typeof InteractionJournalEntrySchemaZ>;
