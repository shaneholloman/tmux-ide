import { z } from "zod";
import { InteractionPaneEndpointSchemaZ } from "./interaction-evidence.ts";

/** Intentionally separate from the legacy caller-UUID mutation endpoint. */
export const AUTOMATION_API_PATH = "/api/v1/automation" as const;
export const AUTOMATION_INPUT_MAX_BYTES = 16 * 1024;

export const AutomationOperationHandleSchemaZ = z
  .object({ generation: z.uuid(), operationId: z.uuid() })
  .strict();

export const AutomationPaneEndpointSchemaZ = InteractionPaneEndpointSchemaZ.options[0];
const endpoints = {
  target: AutomationPaneEndpointSchemaZ,
  // A claim is not authority: a separately supplied capability must validate
  // this exact source lifetime. Missing source remains explicitly unbound.
  source: AutomationPaneEndpointSchemaZ.nullable(),
};
export const AutomationOperationIntentSchemaZ = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("send"),
      ...endpoints,
      text: z
        .string()
        .max(AUTOMATION_INPUT_MAX_BYTES)
        .refine((value) => !value.includes("\0"), "Input contains NUL")
        .refine(
          (value) => new TextEncoder().encode(value).byteLength <= AUTOMATION_INPUT_MAX_BYTES,
          "Input exceeds UTF-8 byte limit",
        ),
      enter: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("read"), ...endpoints }).strict(),
]);
export const AutomationReserveRequestSchemaZ = z
  .object({ version: z.literal(1), intent: AutomationOperationIntentSchemaZ })
  .strict();
export const AutomationExecuteRequestSchemaZ = AutomationReserveRequestSchemaZ.extend({
  handle: AutomationOperationHandleSchemaZ,
}).strict();

/** Status and replay summaries never contain sent or captured terminal content. */
export const AutomationOperationSummarySchemaZ = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("send"), submitted: z.boolean() }).strict(),
    z
      .object({
        kind: z.literal("read"),
        capturedBytes: z.number().int().nonnegative().max(65536),
        returnedBytes: z.number().int().nonnegative().max(16384),
        truncated: z.boolean(),
      })
      .strict(),
  ])
  .superRefine((summary, context) => {
    if (summary.kind !== "read") return;
    if (
      summary.returnedBytes > summary.capturedBytes ||
      summary.truncated !== summary.returnedBytes < summary.capturedBytes
    ) {
      context.addIssue({ code: "custom", message: "Inconsistent snapshot byte counts" });
    }
  });
export const AutomationOperationStatusSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("reserved") }).strict(),
  z.object({ status: z.literal("running") }).strict(),
  z.object({ status: z.literal("outcome-unknown") }).strict(),
  z.object({ status: z.literal("completed"), result: AutomationOperationSummarySchemaZ }).strict(),
]);

export type AutomationOperationHandle = z.infer<typeof AutomationOperationHandleSchemaZ>;
export type AutomationOperationIntent = z.infer<typeof AutomationOperationIntentSchemaZ>;
export type AutomationOperationSummary = z.infer<typeof AutomationOperationSummarySchemaZ>;
