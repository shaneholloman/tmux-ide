/** Explicit synthetic inventory for tests of receipt rules unrelated to provenance. */
export function scopedReceiptFixture<T extends Record<string, unknown>>(raw: T) {
  const pane =
    raw.operationKind === "workspace.pane.read" || raw.operationKind === "workspace.pane.send";
  const id = "00000000-0000-4000-8000-000000000001";
  const endpoint = (semanticPaneId: unknown) => ({
    kind: "pane",
    environmentId: id,
    serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: id },
    paneLifetimeId: id,
    workspaceName: raw.workspaceName,
    semanticPaneId,
  });
  const target = raw.target as { semanticPaneId?: unknown } | undefined;
  const source = raw.sourceSemanticPaneId ? endpoint(raw.sourceSemanticPaneId) : null;
  return {
    ...raw,
    evidence: pane
      ? {
          schemaVersion: 1,
          interactionId: raw.operationId,
          revision: raw.phase === "accepted" ? 0 : 1,
          endpoints: { destination: endpoint(target?.semanticPaneId), source },
          actor:
            raw.origin === "external"
              ? { kind: "unknown", reason: "stock-hook" }
              : source
                ? { kind: "cooperative", bindingId: id, agentRunId: null }
                : { kind: "unknown", reason: "unbound-source" },
          observation:
            raw.origin === "external"
              ? {
                  kind: "stock-hook",
                  command:
                    raw.operationKind === "workspace.pane.read" ? "capture-pane" : "send-keys",
                }
              : raw.phase === "observed"
                ? {
                    kind: "cooperative-completion",
                    operationId: raw.operationId,
                    verification:
                      raw.operationKind === "workspace.pane.read"
                        ? "daemon-snapshot"
                        : "daemon-input-enqueue",
                  }
                : { kind: "admission", operationId: raw.operationId },
          effect:
            raw.origin !== "external" && raw.phase === "observed"
              ? {
                  kind:
                    raw.operationKind === "workspace.pane.read"
                      ? "snapshot-produced"
                      : "input-enqueued",
                }
              : { kind: "unknown" },
          occurredAt: null,
          timeBasis: "unknown",
          receivedAt: raw.at,
        }
      : null,
  };
}
