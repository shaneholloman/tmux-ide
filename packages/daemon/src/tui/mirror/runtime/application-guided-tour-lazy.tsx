/* @jsxImportSource @opentui/solid */
import { createEffect, Show, type Accessor } from "solid-js";
import type { JSX } from "@opentui/solid";
import type { createApplicationGuidedTourIntegration } from "./application-guided-tour-integration.tsx";
import { createGuidedTourLoader } from "./application-guided-tour-loader.ts";
import {
  loadGuidedTourIntegration,
  type GuidedTourPreparation,
} from "./application-guided-tour-preparation.ts";
import { applicationDaemonEndpoint } from "./application-daemon-authority.ts";
import { guidedTourLabel } from "./guided-tour.ts";

export function GuidedTourCoachMount(props: {
  readonly integration: Accessor<{ Coach(): JSX.Element } | null>;
}) {
  return <Show when={props.integration()}>{(integration) => integration().Coach()}</Show>;
}

type Options = Parameters<typeof createApplicationGuidedTourIntegration>[0];
export function createLazyApplicationGuidedTour(
  options: Options,
  preparation: GuidedTourPreparation,
  reportError: (message: string) => void,
) {
  const loader = createGuidedTourLoader({
    load: loadGuidedTourIntegration,
    initialModule: preparation.module,
    identity: () => applicationDaemonEndpoint().epoch,
    signal: options.lifecycle.signal,
    create: (module) =>
      module.createApplicationGuidedTourIntegration({
        ...options,
        initialState: preparation.state,
      }),
  });
  createEffect(() => {
    const message = loader.error();
    if (message) reportError(message);
  });
  return {
    open: () => {
      void loader.open();
    },
    label: () => loader.integration()?.label() ?? guidedTourLabel(preparation.state),
    Coach: () => <GuidedTourCoachMount integration={loader.integration} />,
  };
}
