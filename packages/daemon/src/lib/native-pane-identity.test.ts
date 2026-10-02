import { expect, it } from "vitest";
import { nativePaneIdentity } from "./native-pane-identity.ts";
const epoch = "00000000-0000-4000-8000-000000000001";
it("requires a proven epoch and positive uint64 birth without numeric truncation", () => {
  expect(nativePaneIdentity(epoch, "18446744073709551615")).toEqual({
    serverEpoch: epoch,
    paneBirthId: "18446744073709551615",
  });
  for (const birth of [null, undefined, "", "0", "01", "-1", "18446744073709551616", 17])
    expect(nativePaneIdentity(epoch, birth)).toBeNull();
  expect(nativePaneIdentity(null, "17")).toBeNull();
  expect(nativePaneIdentity("invalid", "17")).toBeNull();
});
