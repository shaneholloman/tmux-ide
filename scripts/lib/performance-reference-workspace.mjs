import { WorkspaceCatalogResourceV2SchemaZ } from "../../packages/contracts/src/workspace-catalog-resource.ts";

/** Select the same current intent for readiness and the returned evidence. */
export function referenceWorkspaceIntent(raw, target) {
  const catalog = WorkspaceCatalogResourceV2SchemaZ.safeParse(raw);
  if (!catalog.success) return null;
  const matches = catalog.data.intents.filter(
    ({ workspaceName, sessionName, availability }) =>
      workspaceName === target && sessionName === target && availability === "live",
  );
  return matches.length === 1 ? matches[0] : null;
}
