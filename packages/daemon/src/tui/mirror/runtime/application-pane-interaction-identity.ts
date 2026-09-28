import type { InteractionPaneEndpoint } from "@tmux-ide/contracts";
import { interactionPaneEndpointKey } from "@tmux-ide/core";
/** Current metadata is authority; even one matching semantic ID is insufficient. */
export function interactionForCurrentPane<T>(
  interactions: ReadonlyMap<string, T> | undefined,
  endpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }> | null | undefined,
): T | undefined {
  return endpoint ? interactions?.get(interactionPaneEndpointKey(endpoint)) : undefined;
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
