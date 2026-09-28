import {
  InteractionReceiptSchemaZ,
  type InteractionReceipt,
  type InteractionPaneEndpoint,
  type InteractionEffectEvidence,
  type InteractionSafeSummary,
  type PaneSendSafeSummary,
} from "@tmux-ide/contracts";

import { canEnrichInteractionEvidence } from "./interaction-evidence.ts";

type ResolvedInteractionEndpoint = Extract<InteractionPaneEndpoint, { kind: "pane" }>;
export function interactionPaneEndpointKey(endpoint: ResolvedInteractionEndpoint): string {
  return JSON.stringify([
    endpoint.environmentId,
    endpoint.serverScope.serverId,
    endpoint.serverScope.generation,
    endpoint.workspaceName,
    endpoint.paneLifetimeId,
    endpoint.semanticPaneId,
  ]);
}
function receiptOwnerKey(receipt: InteractionReceipt): string {
  const endpoint = receipt.evidence?.endpoints.destination;
  return endpoint
    ? JSON.stringify([
        endpoint.environmentId,
        endpoint.serverScope.serverId,
        endpoint.serverScope.generation,
      ])
    : "structural";
}
function receiptOperationKey(receipt: InteractionReceipt): string {
  return `${receiptOwnerKey(receipt)}:${receipt.operationId}`;
}

export const INTERACTION_ACTIVITY_LIMIT = 64;
/** One shared transient presence window for DOM and OpenTUI chrome. */
export const INTERACTION_PRESENCE_MS = 3_200;

/**
 * Replay restores Activity history, not transient visual presence. Keeping the
 * time check in core prevents a reconnect from making every old pane read or
 * send look live again in one renderer but not another.
 */
export function interactionPresenceIsFresh(
  interaction: Pick<PaneInteractionProjection, "at"> | Pick<InteractionReceipt, "at">,
  nowMs = Date.now(),
  presenceMs = INTERACTION_PRESENCE_MS,
): boolean {
  const occurredAt = Date.parse(interaction.at);
  if (!Number.isFinite(occurredAt)) return false;
  const ageMs = nowMs - occurredAt;
  return ageMs >= 0 && ageMs <= presenceMs;
}

export interface PaneInteractionProjection {
  readonly endpoint: ResolvedInteractionEndpoint;
  readonly sourceEndpoint: ResolvedInteractionEndpoint | null;
  readonly destinationEndpoint: ResolvedInteractionEndpoint;
  readonly effect: InteractionEffectEvidence;
  readonly operationKey: string;
  /** The pane whose chrome owns this projection. */
  readonly paneId: string;
  readonly direction: "incoming" | "outgoing";
  readonly sourcePaneId: string | null;
  readonly destinationPaneId: string;
  readonly operationKind: InteractionReceipt["operationKind"];
  readonly operationId: string;
  readonly phase: InteractionReceipt["phase"];
  readonly origin: InteractionReceipt["origin"];
  readonly label: string;
  readonly sequence: number;
  readonly at: string;
}

/**
 * Renderer-neutral presence semantics shared by the web and OpenTUI hosts.
 *
 * Focus is intentionally absent: an interaction is evidence that one pane was
 * observed or received input, never evidence that the user activated it.
 */
export type PaneInteractionPresenceRole =
  | "read-source"
  | "read-target"
  | "send-source"
  | "send-target";

export interface PaneInteractionPresence {
  readonly role: PaneInteractionPresenceRole;
  readonly kind: "read" | "send";
  readonly endpoint: "source" | "target";
  readonly treatment: "observation" | "transfer";
  readonly tone: "info" | "success" | "danger";
  readonly badge: string;
}

/**
 * Convert one pane projection into the single visual vocabulary every host
 * consumes. Labels are deliberately terse enough for pane chrome; the full,
 * privacy-safe relationship remains available through
 * {@link paneInteractionRelationshipLabel} and the Activity feed.
 */
export function paneInteractionPresence(
  interaction: PaneInteractionProjection,
): PaneInteractionPresence {
  const kind = interaction.operationKind === "workspace.pane.read" ? "read" : "send";
  const endpoint = interaction.direction === "outgoing" ? "source" : "target";
  const role: PaneInteractionPresenceRole = `${kind}-${endpoint}`;
  const failed = interaction.phase === "rejected" || interaction.phase === "timed-out";
  let badge: string;
  if (failed) badge = "FAILED";
  else if (kind === "read")
    badge =
      interaction.phase === "accepted"
        ? "READING"
        : interaction.effect.kind === "snapshot-produced"
          ? "READ"
          : "READ OBSERVED";
  else if (interaction.phase === "accepted") badge = endpoint === "source" ? "SENDING" : "INPUT";
  else if (interaction.effect.kind !== "input-enqueued") badge = "INPUT OBSERVED";
  else badge = endpoint === "source" ? "SENT" : "RECEIVED";
  return {
    role,
    kind,
    endpoint,
    treatment: kind === "read" ? "observation" : "transfer",
    tone: failed ? "danger" : kind === "read" ? "info" : "success",
    badge,
  };
}

export interface InteractionFeedState {
  /** Last contiguous replay-journal sequence incorporated by this feed. */
  readonly sequence: number;
  readonly cursors: Readonly<Record<string, number>>;
  /** One latest receipt per operation, newest first and strictly bounded. */
  readonly activity: readonly InteractionReceipt[];
  /** Latest visible interaction for each semantic pane. */
  readonly panes: Readonly<Record<string, PaneInteractionProjection>>;
}

export function initialInteractionFeedState(): InteractionFeedState {
  return { sequence: 0, cursors: Object.freeze({}), activity: [], panes: Object.freeze({}) };
}

export function paneSendSummaryLabel(summary: PaneSendSafeSummary, observed = false): string {
  if ("observedOnly" in summary) return "input observed";
  const unit = summary.characterCount === 1 ? "character" : "characters";
  return `${observed ? "delivered" : "send"} ${summary.characterCount} ${unit}${summary.submitted ? " + Enter" : ""}`;
}

export function interactionSummaryLabel(
  operationKind: InteractionReceipt["operationKind"],
  summary: InteractionSafeSummary,
  phase: InteractionReceipt["phase"] = "accepted",
): string {
  const observed = phase === "observed";
  switch (operationKind) {
    case "workspace.window.link.select":
      return observed ? "window link selected" : "select window link";
    case "workspace.window.link.unlink":
      return observed ? "window unlinked" : "unlink window";
    case "workspace.window.split":
      return `split ${summary.operationKind === operationKind ? summary.direction : "window"}`;
    case "workspace.window.kill":
      return observed ? "window closed" : "close window";
    case "workspace.pane.kill":
      return observed ? "pane closed" : "close pane";
    case "workspace.session.kill":
      return observed ? "session closed" : "close session";
    case "workspace.rename":
      return observed
        ? `${summary.operationKind === operationKind ? summary.scope : "workspace"} renamed`
        : `rename ${summary.operationKind === operationKind ? summary.scope : "workspace"}`;
    case "workspace.pane.zoom.toggle":
      return `zoom ${summary.operationKind === operationKind ? summary.desired : "changed"}`;
    case "workspace.pane.select":
      return observed ? "pane selected" : "select pane";
    case "workspace.pane.send":
      return summary.operationKind === operationKind
        ? paneSendSummaryLabel(summary, observed)
        : observed
          ? "pane input delivered"
          : "send pane input";
    case "workspace.pane.swap":
      return observed ? "panes swapped" : "swap panes";
    case "workspace.pane.resize":
      return summary.operationKind === operationKind
        ? `resize request · ${summary.cells} ${summary.axis}`
        : "resize pane";
    case "workspace.pane.read":
      return observed ? "pane read observed" : "read pane";
  }
}

export function interactionReceiptLabel(receipt: InteractionReceipt): string {
  const commandOnly = receipt.phase === "observed" && receipt.evidence?.effect.kind === "unknown";
  const action =
    commandOnly && receipt.operationKind === "workspace.pane.send"
      ? "input command observed"
      : commandOnly && receipt.operationKind === "workspace.pane.read"
        ? "read command observed"
        : interactionSummaryLabel(receipt.operationKind, receipt.summary, receipt.phase);
  if (receipt.phase === "accepted") return `${receipt.origin} accepted · ${action}`;
  if (receipt.phase === "rejected") return `${receipt.origin} rejected · ${action}`;
  if (receipt.phase === "timed-out") return `${receipt.origin} timed out · ${action}`;
  return `${receipt.origin} observed · ${action}`;
}

const TERMINAL_INTERACTION_PHASES = new Set<InteractionReceipt["phase"]>([
  "observed",
  "rejected",
  "timed-out",
]);

/** One operation may advance exactly once from admission to a terminal verdict. */
export function interactionPhaseCanAdvance(
  previous: InteractionReceipt["phase"],
  next: InteractionReceipt["phase"],
): boolean {
  return previous === "accepted" && TERMINAL_INTERACTION_PHASES.has(next);
}

/** Immutable request identity; authenticated source and proof arrive only at observation. */
export function interactionReceiptIdentity(receipt: InteractionReceipt): string {
  return JSON.stringify({
    operationId: receipt.operationId,
    origin: receipt.origin,
    workspaceName: receipt.workspaceName,
    target: receipt.target,
    operationKind: receipt.operationKind,
    summary: receipt.summary,
    destination: receipt.evidence?.endpoints.destination ?? null,
  });
}

export function interactionReceiptTargetLabel(
  receipt: Pick<InteractionReceipt, "operationKind" | "origin" | "target" | "evidence">,
  paneLabel: (endpoint: ResolvedInteractionEndpoint) => string = (endpoint) =>
    endpoint.semanticPaneId,
): string {
  const destination = receipt.evidence?.endpoints.destination;
  const source = receipt.evidence?.endpoints.source;
  if (
    destination?.kind === "pane" &&
    (receipt.operationKind === "workspace.pane.send" ||
      receipt.operationKind === "workspace.pane.read")
  ) {
    return paneInteractionRelationshipLabel(
      {
        origin: receipt.origin,
        sourceEndpoint: source?.kind === "pane" ? source : null,
        destinationEndpoint: destination,
        operationKind: receipt.operationKind,
      },
      paneLabel,
    );
  }
  if (destination?.kind === "pane") return paneLabel(destination);
  return receipt.target.kind === "window"
    ? "Window"
    : receipt.target.kind === "pane"
      ? "Pane"
      : "Session";
}
export interface PaneInteractionRelationship {
  readonly origin: InteractionReceipt["origin"];
  readonly sourceEndpoint: ResolvedInteractionEndpoint | null;
  readonly destinationEndpoint: ResolvedInteractionEndpoint;
  readonly operationKind?: InteractionReceipt["operationKind"];
}
/** Names are resolved only from authoritative current endpoint metadata. */
export function paneInteractionRelationshipLabel(
  interaction: PaneInteractionRelationship,
  paneLabel: (endpoint: ResolvedInteractionEndpoint) => string = (endpoint) =>
    endpoint.semanticPaneId,
): string {
  const read = interaction.operationKind === "workspace.pane.read";
  const source = interaction.sourceEndpoint
    ? paneLabel(interaction.sourceEndpoint)
    : interaction.origin === "external"
      ? read
        ? "External reader"
        : "External input"
      : `${interaction.origin.toUpperCase()} ${read ? "reader" : "input"}`;
  return `${source}${read ? " reads " : " → "}${paneLabel(interaction.destinationEndpoint)}`;
}

/**
 * Reduce a replayed/live receipt into the one renderer-neutral feed shared by
 * DOM and OpenTUI. Duplicate/older frames are harmless and each operation
 * occupies one Activity row as it advances through phases.
 */
export function reduceInteractionReceipt(
  previous: InteractionFeedState,
  raw: InteractionReceipt,
): InteractionFeedState {
  const receipt = InteractionReceiptSchemaZ.parse(raw);
  const ownerKey = receiptOwnerKey(receipt);
  if (receipt.sequence <= (previous.cursors[ownerKey] ?? 0)) return previous;
  const sequence = Math.max(previous.sequence, receipt.sequence);
  const nextCursors = { ...previous.cursors, [ownerKey]: receipt.sequence };
  const ownerKeys = Object.keys(nextCursors);
  for (const expired of ownerKeys.slice(0, Math.max(0, ownerKeys.length - 128)))
    delete nextCursors[expired];
  const cursors = Object.freeze(nextCursors);
  const operationKey = receiptOperationKey(receipt);
  const existing = previous.activity.find((entry) => receiptOperationKey(entry) === operationKey);
  if (existing) {
    const enriches =
      existing.evidence !== null &&
      receipt.evidence !== null &&
      canEnrichInteractionEvidence(existing.evidence, receipt.evidence);
    const validTransition =
      interactionPhaseCanAdvance(existing.phase, receipt.phase) ||
      (existing.phase === receipt.phase && enriches);
    if (
      interactionReceiptIdentity(existing) !== interactionReceiptIdentity(receipt) ||
      !validTransition ||
      (existing.evidence !== null && receipt.evidence !== null && !enriches)
    )
      return { ...previous, sequence, cursors };
  }
  const activity = [
    receipt,
    ...previous.activity.filter((entry) => receiptOperationKey(entry) !== operationKey),
  ].slice(0, INTERACTION_ACTIVITY_LIMIT);
  const panes: Record<string, PaneInteractionProjection> = Object.fromEntries(
    Object.entries(previous.panes).filter(
      ([, projection]) => projection.operationKey !== operationKey,
    ),
  );
  const evidence = receipt.evidence;
  const destination = evidence?.endpoints.destination;
  if (
    receipt.target.kind !== "pane" ||
    (receipt.operationKind !== "workspace.pane.send" &&
      receipt.operationKind !== "workspace.pane.read") ||
    !evidence ||
    destination?.kind !== "pane"
  )
    return { sequence, cursors, activity, panes: Object.freeze(panes) };
  const source = evidence.endpoints.source?.kind === "pane" ? evidence.endpoints.source : null;
  const projection = (
    endpoint: ResolvedInteractionEndpoint,
    direction: PaneInteractionProjection["direction"],
  ): PaneInteractionProjection => ({
    endpoint,
    sourceEndpoint: source,
    destinationEndpoint: destination,
    effect: evidence.effect,
    operationKey,
    paneId: endpoint.semanticPaneId,
    direction,
    sourcePaneId: source?.semanticPaneId ?? null,
    destinationPaneId: destination.semanticPaneId,
    operationKind: receipt.operationKind,
    operationId: receipt.operationId,
    phase: receipt.phase,
    origin: receipt.origin,
    label: interactionReceiptLabel(receipt),
    sequence: receipt.sequence,
    at: receipt.at,
  });
  panes[interactionPaneEndpointKey(destination)] = projection(destination, "incoming");
  if (source && interactionPaneEndpointKey(source) !== interactionPaneEndpointKey(destination))
    panes[interactionPaneEndpointKey(source)] = projection(source, "outgoing");
  return { sequence, cursors, activity, panes: Object.freeze(panes) };
}

export function interactionForPane(
  state: InteractionFeedState,
  endpoint: ResolvedInteractionEndpoint,
): PaneInteractionProjection | null {
  return state.panes[interactionPaneEndpointKey(endpoint)] ?? null;
}
