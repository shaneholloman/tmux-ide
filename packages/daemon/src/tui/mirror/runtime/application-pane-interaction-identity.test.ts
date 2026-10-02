import { expect, it } from "vitest";
import { interactionPaneEndpointKey } from "@tmux-ide/core";
import {
  interactionForCurrentPane,
  nameForCurrentEndpoint,
} from "../ui/pane-interaction-presentation.ts";
const uuid = "00000000-0000-4000-8000-000000000001";
const endpoint = {
  kind: "pane" as const,
  environmentId: uuid,
  serverScope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: uuid },
  workspaceName: "workspace.alpha",
  semanticPaneId: "pane.alpha",
  paneLifetimeId: uuid,
};
it("never joins by semantic ID even when only one foreign event or agent exists", () => {
  const event = { label: "foreign" };
  for (const foreign of [
    { ...endpoint, environmentId: "00000000-0000-4000-8000-000000000002" },
    { ...endpoint, paneLifetimeId: "00000000-0000-4000-8000-000000000002" },
    {
      ...endpoint,
      serverScope: { ...endpoint.serverScope, generation: "00000000-0000-4000-8000-000000000002" },
    },
    { ...endpoint, workspaceName: "workspace.beta" },
  ]) {
    expect(
      interactionForCurrentPane(new Map([[interactionPaneEndpointKey(foreign), event]]), endpoint),
    ).toBeUndefined();
    expect(
      nameForCurrentEndpoint([{ name: "Foreign", interactionEndpoint: foreign }], endpoint),
    ).toBeUndefined();
  }
  expect(
    interactionForCurrentPane(new Map([[endpoint.semanticPaneId, event]]), endpoint),
  ).toBeUndefined();
  expect(
    interactionForCurrentPane(new Map([[interactionPaneEndpointKey(endpoint), event]]), null),
  ).toBeUndefined();
  expect(
    interactionForCurrentPane(new Map([[interactionPaneEndpointKey(endpoint), event]]), endpoint),
  ).toBe(event);
  expect(
    nameForCurrentEndpoint([{ name: "Current", interactionEndpoint: endpoint }], endpoint),
  ).toBe("Current");
});
