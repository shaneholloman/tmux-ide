import { expect, it } from "vitest";
import { decodeNativeOperationReply } from "./native-operation-reply.ts";
const expected = {
  serverEpoch: "00000000-0000-4000-8000-000000000001",
  operationId: "00000000-0000-4000-8000-000000000002",
};
const acknowledgement = {
  schemaVersion: 2,
  type: "operation-identity",
  ...expected,
  connectionId: "3",
  wrapperCommandId: "4",
};
it("preserves the transient capture tail including empty lines and embedded JSON", () => {
  const captured = `\nprivate terminal text\n${JSON.stringify(acknowledgement)}\n\n`;
  expect(
    decodeNativeOperationReply(`${JSON.stringify(acknowledgement)}\n${captured}`, expected),
  ).toEqual({ acknowledgement, output: captured });
});
it("never searches later terminal lines for an acknowledgement or exposes them in failures", () => {
  for (const reply of [
    `secret\n${JSON.stringify(acknowledgement)}\n`,
    `${"secret".repeat(200)}\n`,
    JSON.stringify(acknowledgement),
    `${JSON.stringify({ ...acknowledgement, connectionId: "0" })}\nsecret`,
    `${JSON.stringify({ ...acknowledgement, operationId: expected.serverEpoch })}\nsecret`,
    `${JSON.stringify({ ...acknowledgement, serverEpoch: expected.operationId })}\nsecret`,
  ]) {
    try {
      decodeNativeOperationReply(reply, expected);
      throw new Error("unexpected success");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
      expect((error as Error).message).toMatch(/native operation acknowledgement/iu);
    }
  }
});
