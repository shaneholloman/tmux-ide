import {
  NativeOperationIdentitySchemaZ,
  NativeJournalIdentitySchemaZ,
  type NativeOperationIdentity,
  type NativeJournalIdentity,
} from "@tmux-ide/contracts";

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

/** Decode identity from the same short-lived connection which executed the wrapper. */
export function decodeNativeOperationInvocation(
  output: string,
  expected: Readonly<{ serverEpoch: string; operationId: string }>,
): {
  readonly identity: NativeJournalIdentity;
  readonly acknowledgement: NativeOperationIdentity;
  readonly output: string;
} {
  const end = output.indexOf("\n");
  if (end < 0 || end > 1024) throw new Error("Missing bounded native connection identity");
  let identity: NativeJournalIdentity;
  try {
    identity = NativeJournalIdentitySchemaZ.parse(JSON.parse(output.slice(0, end)));
  } catch {
    throw new Error("Invalid native connection identity");
  }
  const reply = decodeNativeOperationReply(output.slice(end + 1), expected);
  if (
    identity.serverEpoch !== expected.serverEpoch ||
    identity.connectionId !== reply.acknowledgement.connectionId
  )
    throw new Error("Native execution connection identity mismatch");
  return { identity, ...reply };
}
