import {
  InteractionEvidenceSchemaZ,
  InteractionReceiptSchemaZ,
  NativeOperationIdentitySchemaZ,
  type InteractionReceipt,
  type InteractionEvidence,
} from "@tmux-ide/contracts";
import { canEnrichInteractionEvidence } from "@tmux-ide/core";
import type { OwnedNativeInteractionDecision } from "./owned-native-interaction-bindings.ts";
import type {
  InteractionReceiptDraft,
  InteractionReceiptJournal,
} from "./interaction-receipt-journal.ts";
import { nativeInteractionReference } from "./native-interaction-projector.ts";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function correlatedEvidence(
  receipt: InteractionReceipt,
  decision: OwnedNativeInteractionDecision,
): InteractionEvidence | null {
  if (
    !InteractionReceiptSchemaZ.safeParse(receipt).success ||
    !InteractionEvidenceSchemaZ.safeParse(decision.evidence).success
  )
    return null;
  const proof = decision.proof,
    native = decision.evidence;
  if (
    decision.disposition !== "authored" ||
    !proof ||
    !proof.authoredDestination ||
    receipt.origin === "external" ||
    (receipt.operationKind !== "workspace.pane.read" &&
      receipt.operationKind !== "workspace.pane.send") ||
    receipt.operationId !== proof.acknowledgement.operationId ||
    !receipt.evidence ||
    !same(receipt.evidence.endpoints.destination, proof.authoredDestination) ||
    !same(receipt.evidence.endpoints.source, proof.source?.endpoint ?? null) ||
    native.observation.kind !== "native-journal" ||
    native.actor.kind !== "native" ||
    native.actor.identity !== "connection" ||
    native.actor.classification.kind === "viewer" ||
    native.observation.serverEpoch !== proof.acknowledgement.serverEpoch ||
    !same(native.endpoints.destination, proof.target) ||
    !same(native.endpoints.source, proof.source?.endpoint ?? null) ||
    native.actor.sourceBindingId !== (proof.source?.bindingId ?? null)
  )
    return null;
  const ack = NativeOperationIdentitySchemaZ.safeParse(proof.acknowledgement);
  if (
    !ack.success ||
    proof.target.environmentId !== proof.authoredDestination.environmentId ||
    !same(proof.target.serverScope, proof.authoredDestination.serverScope)
  )
    return null;
  const reference = (kind: string, value: string) =>
    nativeInteractionReference([
      proof.target.environmentId,
      proof.target.serverScope.serverId,
      proof.target.serverScope.generation,
      ack.data.serverEpoch,
      kind,
      value,
    ]);
  if (
    native.actor.issuerId !== reference("issuer", ack.data.connectionId) ||
    native.observation.parentCommandId !== reference("command", ack.data.wrapperCommandId)
  )
    return null;
  const before = receipt.evidence;
  const next = InteractionEvidenceSchemaZ.safeParse({
    ...native,
    interactionId: receipt.operationId,
    revision: before.revision + 1,
    endpoints: { source: before.endpoints.source, destination: proof.authoredDestination },
    occurredAt: before.occurredAt,
    timeBasis: before.timeBasis,
    receivedAt:
      Date.parse(native.receivedAt) >= Date.parse(before.receivedAt)
        ? native.receivedAt
        : before.receivedAt,
    observation: { ...native.observation, correlatedOperationId: receipt.operationId },
    effect: native.effect.kind === "unknown" ? before.effect : native.effect,
  });
  if (!next.success || !canEnrichInteractionEvidence(before, next.data)) return null;
  if (
    same(before.observation, next.data.observation) &&
    same(before.actor, next.data.actor) &&
    same(before.effect, next.data.effect)
  )
    return null;
  return next.data;
}
/** Exact owned transport proof can enrich facts, never the operation's phase or result. */
export function enrichAuthoredNativeReceipt(
  receipt: InteractionReceipt,
  decision: OwnedNativeInteractionDecision,
): InteractionReceiptDraft | null {
  if (receipt.phase === "accepted") return null;
  const evidence = correlatedEvidence(receipt, decision);
  if (!evidence) return null;
  const parsed = InteractionReceiptSchemaZ.safeParse({ ...receipt, evidence });
  if (!parsed.success) return null;
  const { type: _type, sequence: _sequence, ...draft } = parsed.data;
  void _type;
  void _sequence;
  return draft;
}
/** True only when the same bounded journal received a valid correlated revision. */
export function consumeAuthoredNativeEvidence(
  journal: InteractionReceiptJournal,
  decision: OwnedNativeInteractionDecision,
): boolean {
  if (decision.disposition !== "authored" || !decision.proof) return false;
  const latest = journal.latestOperationReceipt(decision.proof.acknowledgement.operationId);
  if (!latest) return false;
  const draft = enrichAuthoredNativeReceipt(latest, decision);
  if (!draft) return false;
  journal.publish(draft);
  return true;
}

/** An accepted operation may retain matching proof, but cannot publish an invented phase. */
export function canStageAuthoredNativeEvidence(
  receipt: InteractionReceipt,
  decision: OwnedNativeInteractionDecision,
): boolean {
  return receipt.phase === "accepted" && correlatedEvidence(receipt, decision) !== null;
}
