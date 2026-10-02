import assert from "node:assert/strict";
import { test } from "node:test";
import { CoherenceDeliveryClient } from "./coherence-delivery-client.ts";
import {
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
} from "../../packages/core/src/terminal-delivery.ts";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "../../packages/core/src/terminal-replica.ts";
import { TerminalDeliveryEnvelopeSchemaZ } from "../../packages/contracts/src/index.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const nonce = "00000000-0000-4000-8000-000000000002";
const transactionId = "00000000-0000-4000-8000-000000000003";

function fixture() {
  const snapshot = blankTerminalReplicaSnapshot(2, 1);
  const bytes = encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
  const chunks = splitTerminalDeliveryChunks(transactionId, bytes);
  const envelope = TerminalDeliveryEnvelopeSchemaZ.parse({
    type: "terminal.delivery",
    workspaceName: "workspace",
    semanticPaneId: "pane",
    generation,
    incarnation: `${generation}:0`,
    deliveryNonce: nonce,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-v1",
    frame: "seed",
    baseRevision: null,
    canonicalRevision: 0,
    canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: chunks.length,
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: false,
  });
  const acks: unknown[] = [];
  const client = new CoherenceDeliveryClient("workspace", "pane", (ack) => acks.push(ack));
  client.negotiate(
    negotiateTerminalDelivery(
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      generation,
      nonce,
    ),
  );
  return { client, acks, envelope, chunks, snapshot };
}

test("held acknowledgement follows a fully decoded snapshot and releases exactly once", () => {
  const { client, acks, envelope, chunks, snapshot } = fixture();
  client.hold();
  client.receive(envelope);
  assert.equal(client.commits, 0);
  chunks.forEach((chunk) => client.receive(chunk));
  assert.equal(client.commits, 1);
  assert.deepEqual(client.state?.canonicalSnapshot, snapshot);
  assert.equal(acks.length, 0);
  assert.equal(client.acknowledgementHeld, true);
  client.release();
  assert.equal(client.acknowledgementHeld, false);
  client.release();
  assert.equal(acks.length, 1);
});

test("corrupted delivery bytes are never acknowledged", () => {
  const { client, acks, envelope, chunks } = fixture();
  client.receive(envelope);
  const corrupted = chunks.map((chunk) => ({ ...chunk, bytes: chunk.bytes.slice() }));
  corrupted[0]!.bytes[0] ^= 1;
  assert.throws(() => corrupted.forEach((chunk) => client.receive(chunk)));
  assert.equal(client.commits, 0);
  assert.equal(acks.length, 0);
});

test("a valid representation with a false canonical hash is never acknowledged", () => {
  const { client, acks, envelope, chunks } = fixture();
  client.receive({ ...envelope, canonicalStateHash: "0000000000000000" });
  assert.throws(() => chunks.forEach((chunk) => client.receive(chunk)));
  assert.equal(client.commits, 0);
  assert.equal(acks.length, 0);
});
