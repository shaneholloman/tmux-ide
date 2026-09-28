import { z } from "zod";
import { EnvironmentIdSchema } from "./daemon-wire.ts";
import { DesktopWorkspaceNameSchemaZ } from "./desktop-workspace-name.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { TmuxServerScopeSchemaZ } from "./owner-scope-identity.ts";

const uuid = z.uuid();
const time = z.iso.datetime({ offset: true });
const authority = { environmentId: EnvironmentIdSchema, serverScope: TmuxServerScopeSchemaZ };

/** Decimal uint64 avoids JavaScript's unsafe integer range. Epoch is native, not daemon identity. */
export const NativeInteractionSequenceSchemaZ = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/u)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n,
    "sequence exceeds uint64",
  );
/** Immutable physical pane identity; zero is reserved for unproven birth. */
export const NativePaneIdentitySchemaZ = z
  .object({
    serverEpoch: uuid,
    paneBirthId: NativeInteractionSequenceSchemaZ.refine(
      (value) => value !== "0",
      "pane birth must be positive",
    ),
  })
  .strict();
export type NativePaneIdentity = z.infer<typeof NativePaneIdentitySchemaZ>;

/** Public endpoints never expose socket paths or recyclable native pane numbers. */
export const InteractionPaneEndpointSchemaZ = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pane"),
      ...authority,
      paneLifetimeId: uuid,
      workspaceName: DesktopWorkspaceNameSchemaZ,
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    })
    .strict(),
  z
    .object({ kind: z.literal("native-pane"), ...authority, ...NativePaneIdentitySchemaZ.shape })
    .strict(),
  z.object({ kind: z.literal("unresolved-pane"), ...authority, observationRef: uuid }).strict(),
]);
export type InteractionPaneEndpoint = z.infer<typeof InteractionPaneEndpointSchemaZ>;

/** These are authority-validated assertions, never caller authentication credentials. */
export const InteractionActorEvidenceSchemaZ = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("unknown"),
      reason: z.enum(["stock-hook", "unbound-source", "new-client-boundary", "unavailable"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("cooperative"), bindingId: uuid, agentRunId: uuid.nullable() })
    .strict(),
  z
    .object({
      kind: z.literal("native"),
      issuerId: uuid,
      identity: z.enum(["connection", "kernel-peer", "advertised-process", "process-linked"]),
      sourceBindingId: uuid.nullable(),
      classification: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("unknown") }).strict(),
        z.object({ kind: z.literal("viewer"), bindingId: uuid }).strict(),
        z.object({ kind: z.literal("agent"), bindingId: uuid, agentRunId: uuid }).strict(),
      ]),
    })
    .strict(),
]);
export type InteractionActorEvidence = z.infer<typeof InteractionActorEvidenceSchemaZ>;

export const NativeInteractionCursorSchemaZ = z
  .object({
    epoch: uuid,
    sequence: NativeInteractionSequenceSchemaZ,
  })
  .strict();
export type NativeInteractionCursor = z.infer<typeof NativeInteractionCursorSchemaZ>;

const command = z.enum(["send-keys", "paste-buffer", "capture-pane", "send-prefix"]);
export const InteractionObservationEvidenceSchemaZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("admission"), operationId: uuid }).strict(),
  z
    .object({
      kind: z.literal("cooperative-completion"),
      operationId: uuid,
      verification: z.enum(["semantic-readback", "daemon-input-enqueue", "daemon-snapshot"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("stock-hook"), command: z.enum(["send-keys", "capture-pane"]) })
    .strict(),
  z
    .object({
      kind: z.literal("native-journal"),
      command: z.union([command, z.literal("unknown")]),
      cursor: NativeInteractionCursorSchemaZ,
      commandId: uuid.nullable(),
      parentCommandId: uuid.nullable(),
      correlatedOperationId: uuid.nullable(),
    })
    .strict(),
]);
export type InteractionObservationEvidence = z.infer<typeof InteractionObservationEvidenceSchemaZ>;

export const InteractionEffectEvidenceSchemaZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({
      kind: z.literal("no-input"),
      reason: z.enum(["copy-mode", "reset", "no-op", "input-disabled"]),
    })
    .strict(),
  z.object({ kind: z.literal("input-enqueued") }).strict(),
  z.object({ kind: z.literal("snapshot-produced") }).strict(),
]);
export type InteractionEffectEvidence = z.infer<typeof InteractionEffectEvidenceSchemaZ>;

/** Foundation for the existing receipt, not a second event/feed envelope. */
export const InteractionEvidenceSchemaZ = z
  .object({
    schemaVersion: z.literal(1),
    interactionId: uuid,
    revision: z.number().int().nonnegative(),
    endpoints: z
      .object({
        destination: InteractionPaneEndpointSchemaZ,
        source: InteractionPaneEndpointSchemaZ.nullable(),
      })
      .strict(),
    actor: InteractionActorEvidenceSchemaZ,
    observation: InteractionObservationEvidenceSchemaZ,
    effect: InteractionEffectEvidenceSchemaZ,
    occurredAt: time.nullable(),
    timeBasis: z.enum(["daemon", "server", "unknown"]),
    receivedAt: time,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: string[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const { observation, actor, effect, endpoints } = value;
    for (const endpoint of [endpoints.destination, endpoints.source]) {
      if (
        endpoint?.kind === "native-pane" &&
        (observation.kind !== "native-journal" || endpoint.serverEpoch !== observation.cursor.epoch)
      )
        issue(["endpoints"], "physical pane identity requires matching native server epoch");
    }
    if ((value.occurredAt === null) !== (value.timeBasis === "unknown"))
      issue(["timeBasis"], "unknown time requires a null occurrence timestamp");
    if (actor.kind === "unknown" && endpoints.source !== null)
      issue(["endpoints", "source"], "unknown actors cannot claim a source endpoint");
    if (actor.kind === "cooperative" && endpoints.source?.kind !== "pane")
      issue(["endpoints", "source"], "cooperative actors require a validated resolved source");
    if (actor.kind === "native") {
      if ((endpoints.source !== null) !== (actor.sourceBindingId !== null))
        issue(["actor", "sourceBindingId"], "native source requires a matching validated binding");
      if (endpoints.source?.kind === "unresolved-pane")
        issue(["endpoints", "source"], "native source binding must resolve a pane lifetime");
      if (actor.identity === "advertised-process" && actor.classification.kind !== "unknown")
        issue(
          ["actor", "classification"],
          "advertised process identity cannot classify a viewer or agent",
        );
      if (observation.kind !== "native-journal")
        issue(["observation"], "native actor requires native journal evidence");
    }
    if (
      observation.kind === "stock-hook" &&
      (actor.kind !== "unknown" || effect.kind !== "unknown")
    )
      issue(["observation"], "stock hooks prove neither actor nor input/snapshot effect");
    if (observation.kind === "admission" && effect.kind !== "unknown")
      issue(["effect"], "admission proves no effect");
    if (
      observation.kind === "cooperative-completion" &&
      ((observation.verification === "daemon-input-enqueue" && effect.kind !== "input-enqueued") ||
        (observation.verification === "daemon-snapshot" && effect.kind !== "snapshot-produced") ||
        (observation.verification === "semantic-readback" && effect.kind !== "unknown"))
    )
      issue(["effect"], "cooperative effect must match its verification method");
    if (
      (observation.kind === "admission" || observation.kind === "cooperative-completion") &&
      observation.operationId !== value.interactionId
    )
      issue(
        ["observation", "operationId"],
        "operation correlation must match interaction identity",
      );
    if (observation.kind === "native-journal") {
      if (
        observation.correlatedOperationId !== null &&
        observation.correlatedOperationId !== value.interactionId
      )
        issue(
          ["observation", "correlatedOperationId"],
          "native correlation must match interaction identity",
        );
      if (
        observation.command === "capture-pane" &&
        !["unknown", "snapshot-produced"].includes(effect.kind)
      )
        issue(["effect"], "capture cannot assert input effects");
      if (
        observation.command !== "capture-pane" &&
        observation.command !== "unknown" &&
        effect.kind === "snapshot-produced"
      )
        issue(["effect"], "input commands cannot assert capture effects");
    }
  });
export type InteractionEvidence = z.infer<typeof InteractionEvidenceSchemaZ>;

export const InteractionObservationGapSchemaZ = z
  .object({
    reason: z.enum([
      "hooks-replaced",
      "retention-overflow",
      "uncertain-consume",
      "unresolved-target",
      "native-range-dropped",
      "epoch-reset",
      "transport-replay-gap",
    ]),
    at: time,
    range: z
      .object({
        epoch: uuid,
        from: NativeInteractionSequenceSchemaZ,
        to: NativeInteractionSequenceSchemaZ,
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.range &&
      NativeInteractionSequenceSchemaZ.safeParse(value.range.from).success &&
      NativeInteractionSequenceSchemaZ.safeParse(value.range.to).success &&
      BigInt(value.range.from) > BigInt(value.range.to)
    )
      context.addIssue({ code: "custom", path: ["range"], message: "gap range must be ordered" });
  });
export type InteractionObservationGap = z.infer<typeof InteractionObservationGapSchemaZ>;

/** Latest per-server observer state; journal/replay ownership stays with existing daemon resources. */
export const InteractionObservationStatusSchemaZ = z
  .object({
    schemaVersion: z.literal(1),
    ...authority,
    method: z.enum(["stock-hooks", "native-journal", "unavailable"]),
    capabilityVersion: z.number().int().positive().nullable(),
    commands: z.array(command).max(4),
    effects: z.array(z.enum(["no-input", "input-enqueued", "snapshot-produced"])).max(3),
    coverage: z.enum(["partial", "declared-capabilities", "unavailable"]),
    cursor: NativeInteractionCursorSchemaZ.nullable(),
    lastGap: InteractionObservationGapSchemaZ.nullable(),
    droppedCount: NativeInteractionSequenceSchemaZ.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const issue = (path: string[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    if (
      new Set(value.commands).size !== value.commands.length ||
      new Set(value.effects).size !== value.effects.length
    )
      issue(["commands"], "capability lists must be unique");
    if (value.method !== "native-journal" && (value.cursor !== null || value.effects.length > 0))
      issue(["method"], "only native observation advertises effects or a journal cursor");
    if (
      value.method === "stock-hooks" &&
      (value.coverage !== "partial" ||
        value.commands.includes("paste-buffer") ||
        value.commands.includes("send-prefix"))
    )
      issue(["coverage"], "stock hooks have partial send-keys/capture-pane coverage");
    if (
      value.method === "unavailable" &&
      (value.coverage !== "unavailable" ||
        value.commands.length > 0 ||
        value.capabilityVersion !== null)
    )
      issue(["coverage"], "unavailable observer cannot advertise capabilities");
    if (
      value.method !== "unavailable" &&
      (value.coverage === "unavailable" || value.capabilityVersion === null)
    )
      issue(["capabilityVersion"], "available observer requires a capability version and coverage");
  });
export type InteractionObservationStatus = z.infer<typeof InteractionObservationStatusSchemaZ>;
