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
        .min(1)
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
  .object({
    version: z.literal(1),
    intent: AutomationOperationIntentSchemaZ,
    // Adapter metadata is a declaration, never evidence of the calling agent.
    // Existing v1 clients omitted it and retain their original SDK label.
    origin: z.enum(["cli", "sdk", "mcp"]).default("sdk"),
  })
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

const displayLabel = z
  .string()
  .max(160)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && (code < 127 || code > 159);
    }),
  );
export const AutomationPanesResponseSchemaZ = z
  .object({
    version: z.literal(1),
    // Resolved by the daemon from the invoking pane credential, never a title.
    source: AutomationPaneEndpointSchemaZ.nullable().optional(),
    panes: z
      .array(
        z
          .object({
            endpoint: AutomationPaneEndpointSchemaZ,
            title: displayLabel.nullable(),
            sessionName: displayLabel,
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();
export const AutomationReserveResponseSchemaZ = z
  .object({
    version: z.literal(1),
    handle: AutomationOperationHandleSchemaZ,
  })
  .strict();
const readContent = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      text: z
        .string()
        .max(16384)
        .refine((text) => new TextEncoder().encode(text).byteLength <= 16384),
    })
    .strict(),
  z.object({ availability: z.literal("replay-unavailable"), text: z.null() }).strict(),
]);
export const AutomationExecuteResponseSchemaZ = z
  .object({
    version: z.literal(1),
    handle: AutomationOperationHandleSchemaZ,
    result: AutomationOperationSummarySchemaZ,
    read: readContent.optional(),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (response.result.kind === "send" ? response.read !== undefined : response.read === undefined)
      ctx.addIssue({ code: "custom", message: "Unexpected read payload" });
    if (
      response.result.kind === "read" &&
      response.read?.availability === "available" &&
      new TextEncoder().encode(response.read.text).byteLength !== response.result.returnedBytes
    )
      ctx.addIssue({ code: "custom", message: "Snapshot byte count mismatch" });
  });
const statusEnvelope = { version: z.literal(1), handle: AutomationOperationHandleSchemaZ };
export const AutomationStatusResponseSchemaZ = z.discriminatedUnion("status", [
  AutomationOperationStatusSchemaZ.options[0].extend(statusEnvelope),
  AutomationOperationStatusSchemaZ.options[1].extend(statusEnvelope),
  AutomationOperationStatusSchemaZ.options[2].extend(statusEnvelope),
  AutomationOperationStatusSchemaZ.options[3].extend(statusEnvelope),
]);
export const AutomationErrorResponseSchemaZ = z
  .object({
    error: z
      .object({
        code: z.enum([
          "owner-required",
          "invalid-request",
          "invalid-source",
          "invalid-target",
          "capacity",
          "server-unavailable",
          "operation-unavailable",
        ]),
      })
      .strict(),
  })
  .strict();
export type AutomationPanesResponse = z.infer<typeof AutomationPanesResponseSchemaZ>;
export type AutomationReserveResponse = z.infer<typeof AutomationReserveResponseSchemaZ>;
export type AutomationExecuteResponse = z.infer<typeof AutomationExecuteResponseSchemaZ>;
export type AutomationStatusResponse = z.infer<typeof AutomationStatusResponseSchemaZ>;
export type AutomationErrorResponse = z.infer<typeof AutomationErrorResponseSchemaZ>;
