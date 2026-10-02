import { NativePaneIdentitySchemaZ, type NativePaneIdentity } from "@tmux-ide/contracts";
/** A current inventory row may join physical evidence only with a proven owner epoch. */
export function nativePaneIdentity(
  serverEpoch: string | null | undefined,
  paneBirthId: unknown,
): NativePaneIdentity | null {
  if (!serverEpoch || typeof paneBirthId !== "string" || !paneBirthId || paneBirthId === "0")
    return null;
  const parsed = NativePaneIdentitySchemaZ.safeParse({ serverEpoch, paneBirthId });
  return parsed.success ? parsed.data : null;
}
