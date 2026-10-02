import { describe, expect, it, vi } from "vitest";
import { createEmbeddedTmuxServerOwners } from "./embedded-tmux-server-owners.ts";

vi.mock("./tmux-server-registration.ts", () => ({
  readTmuxServerRegistrations: () => [],
  writeTmuxServerRegistrations: vi.fn(),
  createTmuxServerProbe: () => async () => ({ fingerprint: "verified" }),
}));

describe("embedded owner initialization cleanup", () => {
  it("retires the default exactly once if evidence scope initialization fails before adoption", async () => {
    const dispose = vi.fn(async () => {});
    const failure = new Error("inventory initialization failed");
    await expect(
      createEmbeddedTmuxServerOwners({
        environmentId: "00000000-0000-4000-8000-000000000001",
        defaultAuthority: {
          executablePath: "/fixture/tmux",
          socketSelector: { kind: "path", path: "/fixture/socket" },
        },
        defaultGeneration: "00000000-0000-4000-8000-000000000002",
        expectedDefaultProofDigest: "verified",
        onDefaultScope: async () => {
          throw failure;
        },
        defaultOwner: { dispose } as Parameters<
          typeof createEmbeddedTmuxServerOwners
        >[0]["defaultOwner"],
        stateDirectory: "/fixture",
        webSocketBaseUrl: "ws://localhost:1234",
      }),
    ).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
