import { InteractionEvidenceSchemaZ, type InteractionEvidence } from "@tmux-ide/contracts";

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Validates an already-correlated revision. It cannot establish correlation or
 * authenticate an actor: only the producer with actual evidence can do that.
 * Parsing canonicalizes object key order before immutable facts are compared.
 * Native identity-method upgrades are deliberately unsupported until their
 * proof lattice is specified; connection/process evidence is not a total order.
 */
export function canEnrichInteractionEvidence(
  previous: InteractionEvidence,
  next: InteractionEvidence,
): boolean {
  const before = InteractionEvidenceSchemaZ.safeParse(previous);
  const after = InteractionEvidenceSchemaZ.safeParse(next);
  if (!before.success || !after.success) return false;
  const a = before.data;
  const b = after.data;
  if (
    a.interactionId !== b.interactionId ||
    b.revision <= a.revision ||
    !same(a.endpoints.destination, b.endpoints.destination) ||
    (a.endpoints.source !== null && !same(a.endpoints.source, b.endpoints.source)) ||
    a.occurredAt !== b.occurredAt ||
    a.timeBasis !== b.timeBasis ||
    Date.parse(b.receivedAt) < Date.parse(a.receivedAt)
  )
    return false;
  if (a.effect.kind !== "unknown" && !same(a.effect, b.effect)) return false;

  if (a.actor.kind === "cooperative") {
    if (b.actor.kind === "native") {
      if (
        b.actor.sourceBindingId !== a.actor.bindingId ||
        (a.actor.agentRunId !== null &&
          (b.actor.classification.kind !== "agent" ||
            b.actor.classification.agentRunId !== a.actor.agentRunId))
      )
        return false;
    } else if (!same(a.actor, b.actor)) return false;
  } else if (a.actor.kind === "native") {
    if (
      b.actor.kind !== "native" ||
      a.actor.issuerId !== b.actor.issuerId ||
      a.actor.identity !== b.actor.identity ||
      (a.actor.sourceBindingId !== null && a.actor.sourceBindingId !== b.actor.sourceBindingId) ||
      (a.actor.classification.kind !== "unknown" &&
        !same(a.actor.classification, b.actor.classification))
    )
      return false;
  }

  const x = a.observation;
  const y = b.observation;
  if (x.kind === "native-journal") {
    return (
      y.kind === "native-journal" &&
      x.serverEpoch === y.serverEpoch &&
      x.command === y.command &&
      x.commandId === y.commandId &&
      x.parentCommandId === y.parentCommandId &&
      x.cursor.epoch === y.cursor.epoch &&
      BigInt(y.cursor.sequence) >= BigInt(x.cursor.sequence) &&
      (x.correlatedOperationId === null || x.correlatedOperationId === y.correlatedOperationId)
    );
  }
  if (x.kind === "stock-hook")
    return (
      x.command === ("command" in y ? y.command : null) &&
      (y.kind === "stock-hook" ||
        (y.kind === "native-journal" && y.correlatedOperationId === a.interactionId))
    );
  if (x.kind === "cooperative-completion") {
    return same(x, y) || (y.kind === "native-journal" && y.correlatedOperationId === x.operationId);
  }
  return y.kind === "admission" || y.kind === "cooperative-completion"
    ? y.operationId === x.operationId
    : y.kind === "native-journal" && y.correlatedOperationId === x.operationId;
}
