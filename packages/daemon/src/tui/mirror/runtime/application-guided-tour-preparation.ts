import { readGuidedTourState } from "./guided-tour-storage.ts";
import type { GuidedTourState } from "./guided-tour.ts";

export const loadGuidedTourIntegration = () => import("./application-guided-tour-integration.tsx");
export type GuidedTourIntegrationModule = Awaited<ReturnType<typeof loadGuidedTourIntegration>>;
export interface GuidedTourPreparation {
  readonly state: GuidedTourState;
  readonly module?: GuidedTourIntegrationModule;
}

/** Active saved tours retain their synchronous first mount and first observation. */
export async function prepareApplicationGuidedTour(
  read = readGuidedTourState,
  load = loadGuidedTourIntegration,
): Promise<GuidedTourPreparation> {
  const state = read();
  return state.active ? { state, module: await load() } : { state };
}
