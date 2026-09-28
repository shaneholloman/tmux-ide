import { expect, it } from "vitest";
import { NativeOperationIdentitySchemaZ } from "./native-operation-identity.ts";
const ack = {
  schemaVersion: 2,
  type: "operation-identity",
  serverEpoch: "00000000-0000-4000-8000-000000000001",
  operationId: "00000000-0000-4000-8000-000000000002",
  connectionId: "1",
  wrapperCommandId: "18446744073709551615",
};
it("accepts only bounded positive native identity and strict metadata", () => {
  expect(NativeOperationIdentitySchemaZ.parse(ack)).toEqual(ack);
  for (const bad of [
    { connectionId: "0" },
    { wrapperCommandId: "0" },
    { wrapperCommandId: "18446744073709551616" },
    { connectionId: "01" },
    { text: "secret" },
    { serverEpoch: "invalid" },
    { operationId: "invalid" },
  ])
    expect(NativeOperationIdentitySchemaZ.safeParse({ ...ack, ...bad }).success).toBe(false);
});
