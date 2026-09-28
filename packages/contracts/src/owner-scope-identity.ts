import { z } from "zod";

/** Stable registration identity. Never derive it from a socket path or native ID. */
export const TmuxServerIdSchemaZ = z.string().regex(/^tmux-server\.[a-f0-9]{32}$/u);
/** Fresh live authority incarnation, independently retired for each server owner. */
export const TmuxServerGenerationSchemaZ = z.uuid();
export const TmuxServerScopeSchemaZ = z
  .object({ serverId: TmuxServerIdSchemaZ, generation: TmuxServerGenerationSchemaZ })
  .strict();
