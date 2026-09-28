import { z } from "zod";
import { NativeJournalUint64SchemaZ } from "./native-interaction-journal.ts";
const positive = NativeJournalUint64SchemaZ.refine((value) => value !== "0");
/** Private acknowledgement from the actual executing wrapper, never a caller claim. */
export const NativeOperationIdentitySchemaZ = z
  .object({
    schemaVersion: z.literal(2),
    type: z.literal("operation-identity"),
    serverEpoch: z.uuid(),
    connectionId: positive,
    wrapperCommandId: positive,
    operationId: z.uuid(),
  })
  .strict();
export type NativeOperationIdentity = z.infer<typeof NativeOperationIdentitySchemaZ>;
