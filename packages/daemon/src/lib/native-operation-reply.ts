import { NativeOperationIdentitySchemaZ, type NativeOperationIdentity } from "@tmux-ide/contracts";

/** Decode only the first private acknowledgement; never search terminal text for proof. */
export function decodeNativeOperationReply(
  output: string,
  expected: Readonly<{ serverEpoch: string; operationId: string }>,
): { readonly acknowledgement: NativeOperationIdentity; readonly output: string } {
  const end = output.indexOf("\n");
  if (end < 0 || end > 1024) throw new Error("Missing bounded native operation acknowledgement");
  let acknowledgement: NativeOperationIdentity;
  try {
    acknowledgement = NativeOperationIdentitySchemaZ.parse(JSON.parse(output.slice(0, end)));
  } catch {
    // A reply may contain terminal text. Never include it in an error or log.
    throw new Error("Invalid native operation acknowledgement");
  }
  if (
    acknowledgement.serverEpoch !== expected.serverEpoch ||
    acknowledgement.operationId !== expected.operationId
  )
    throw new Error("Native operation acknowledgement identity mismatch");
  return { acknowledgement, output: output.slice(end + 1) };
}
