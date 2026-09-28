import type { InteractionPaneEndpoint, NativePaneIdentity } from "@tmux-ide/contracts";
import { interactionPaneEndpointKey } from "@tmux-ide/core";
export interface CurrentPaneInteractionMap<T> extends ReadonlyMap<string, T> {
  readonly forPane?: (
    endpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }>,
    nativeIdentity?: NativePaneIdentity | null,
  ) => T | undefined;
}
/** Current metadata is authority; even one matching semantic ID is insufficient. */
export function interactionForCurrentPane<T>(
  interactions: CurrentPaneInteractionMap<T> | undefined,
  endpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }> | null | undefined,
  nativeIdentity?: NativePaneIdentity | null,
): T | undefined {
  if (!endpoint) return undefined;
  return interactions?.forPane
    ? interactions.forPane(endpoint, nativeIdentity)
    : interactions?.get(interactionPaneEndpointKey(endpoint));
}

export function nameForCurrentEndpoint(
  rows: readonly {
    name: string;
    interactionEndpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }> | null;
  }[],
  endpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }>,
): string | undefined {
  const key = interactionPaneEndpointKey(endpoint);
  const matches = rows.filter(
    (row) => row.interactionEndpoint && interactionPaneEndpointKey(row.interactionEndpoint) === key,
  );
  return matches.length === 1 ? matches[0]!.name : undefined;
}
