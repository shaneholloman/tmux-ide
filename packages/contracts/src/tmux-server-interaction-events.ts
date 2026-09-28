import { z } from "zod";
import { TmuxServerScopeSchemaZ } from "./tmux-server-scope.ts";
import { InteractionObservationStatusSchemaZ } from "./interaction-evidence.ts";
import { InteractionJournalEntrySchemaZ } from "./interaction-journal.ts";

export const TMUX_INTERACTION_BATCH_LIMIT = 64;
const cursor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const TmuxInteractionCursorSchemaZ = z
  .object({ server: TmuxServerScopeSchemaZ, cursor })
  .strict();
const base = { version: z.literal(1), server: TmuxServerScopeSchemaZ };
export const TmuxServerInteractionEventSchemaZ = z
  .discriminatedUnion("type", [
    z
      .object({
        ...base,
        type: z.literal("ready"),
        after: cursor,
        observationStatus: InteractionObservationStatusSchemaZ,
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("status"),
        observationStatus: InteractionObservationStatusSchemaZ,
      })
      .strict(),
    z
      .object({
        ...base,
        type: z.literal("batch"),
        after: cursor,
        cursor,
        gap: z.object({ from: cursor, through: cursor }).strict().nullable(),
        receipts: z.array(InteractionJournalEntrySchemaZ).min(1).max(TMUX_INTERACTION_BATCH_LIMIT),
      })
      .strict(),
    z.object({ ...base, type: z.literal("retired") }).strict(),
  ])
  .superRefine((event, ctx) => {
    if (event.type === "ready" || event.type === "status") {
      if (
        event.observationStatus.serverScope.serverId !== event.server.serverId ||
        event.observationStatus.serverScope.generation !== event.server.generation
      )
        ctx.addIssue({ code: "custom", message: "Observation status owner mismatch" });
    }
    if (event.type !== "batch") return;
    let expected = event.after + 1;
    if (event.gap) {
      if (event.gap.from !== expected || event.gap.through < expected)
        ctx.addIssue({ code: "custom", message: "Invalid receipt gap" });
      expected = event.gap.through + 1;
    }
    for (const receipt of event.receipts) {
      if (receipt.sequence !== expected++)
        ctx.addIssue({ code: "custom", message: "Noncontiguous receipt batch" });
    }
    if (event.cursor !== expected - 1 || event.cursor <= event.after)
      ctx.addIssue({ code: "custom", message: "Invalid receipt cursor" });
  });
export type TmuxInteractionCursor = z.infer<typeof TmuxInteractionCursorSchemaZ>;
export type TmuxServerInteractionEvent = z.infer<typeof TmuxServerInteractionEventSchemaZ>;
export type TmuxInteractionBatch = Extract<TmuxServerInteractionEvent, { type: "batch" }>;
