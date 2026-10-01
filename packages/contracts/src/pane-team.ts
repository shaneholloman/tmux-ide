import { z } from "zod";

/** Presentation membership; never grants control of a pane or a harness team. */
export const PaneTeamMembershipSchemaZ = z
  .object({
    id: z.string().regex(/^team\.[a-zA-Z0-9_-]{16,64}$/u),
    name: z
      .string()
      .min(1)
      .max(80)
      .refine(
        (value) =>
          value === value.trim() &&
          Array.from(value).every((character) => {
            const code = character.codePointAt(0)!;
            return code > 31 && (code < 127 || code > 159);
          }),
      ),
    source: z.enum(["manual", "claude-code"]),
  })
  .strict();
export type PaneTeamMembership = z.infer<typeof PaneTeamMembershipSchemaZ>;

/** Scope imported identities to their machine and live server, not session/layout. */
export function paneTeamGroupKey(
  team: PaneTeamMembership,
  machineId: string,
  serverId: string,
  generation: string,
): string {
  return JSON.stringify([machineId, serverId, generation, team.source, team.id]);
}
