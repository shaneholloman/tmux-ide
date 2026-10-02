import { describe, expect, it, vi } from "vitest";
import { PaneSourceDiscovery } from "./pane-source-discovery.ts";
import { PaneSourceCredentialAuthority } from "./pane-source-credentials.ts";

function fixture() {
  let rows = [["%1", "pane.one"]];
  const installed = new Map<string, string>();
  const execute = (args: readonly string[]) => {
    if (args[0] === "list-panes")
      return rows
        .map(([id, semantic]) => `${id}\t${semantic}\t${installed.get(id!) ?? ""}`)
        .join("\n");
    if (args[0] === "set-option") {
      installed.set(args[3]!, args[5]!);
      return "";
    }
    throw new Error("unexpected command");
  };
  const run = vi.fn(execute);
  const runAsync = vi.fn(async (args: readonly string[]) => execute(args));
  const authority = new PaneSourceCredentialAuthority({ run, runAsync });
  let workspaces = [{ sessionName: "session" }];
  const discovery = new PaneSourceDiscovery(authority, () => workspaces);
  const pane = {
    sessionName: "session",
    runtimePaneId: "%1",
    semanticPaneId: "pane.one",
    paneLifetimeId: "lifetime-one",
  };
  return {
    installed,
    run,
    runAsync,
    authority,
    discovery,
    pane,
    setRows: (value: string[][]) => {
      rows = value;
    },
    setAliases: () => {
      workspaces = [{ sessionName: "session" }, { sessionName: "session" }];
    },
  };
}
const liveSignal = () => new AbortController().signal;
describe("trusted pane source discovery", () => {
  it("mints after adoption, caches stable lifetimes, and discovers a newly added pane", async () => {
    const f = fixture();
    await f.discovery.prepare([f.pane], liveSignal());
    const first = f.installed.get("%1");
    expect(first).toBeTruthy();
    expect(f.runAsync).toHaveBeenCalledTimes(2);
    await f.discovery.prepare([f.pane], liveSignal());
    expect(f.runAsync).toHaveBeenCalledTimes(2);
    f.setRows([
      ["%1", "pane.one"],
      ["%2", "pane.two"],
    ]);
    await f.discovery.prepare(
      [
        f.pane,
        {
          ...f.pane,
          runtimePaneId: "%2",
          semanticPaneId: "pane.two",
          paneLifetimeId: "lifetime-two",
        },
      ],
      liveSignal(),
    );
    expect(f.installed.get("%2")).toBeTruthy();
    expect(f.installed.get("%1")).toBe(first);
    expect(f.runAsync).toHaveBeenCalledTimes(4);
  });
  it("does not cache failure, and serializes concurrent minting", async () => {
    const f = fixture();
    f.runAsync.mockRejectedValueOnce(new Error("transient"));
    await expect(f.discovery.prepare([f.pane], liveSignal())).rejects.toThrow("transient");
    await Promise.all([
      f.discovery.prepare([f.pane], liveSignal()),
      f.discovery.prepare([f.pane], liveSignal()),
    ]);
    expect(f.runAsync).toHaveBeenCalledTimes(3);
    expect(f.installed.get("%1")).toBeTruthy();
  });
  it("does not mint from an ambiguous alias or an untrusted credential", async () => {
    const f = fixture();
    expect(f.authority.resolveBinding("forged", "session", "pane.one")).toBeNull();
    expect(f.run).not.toHaveBeenCalled();
    f.setAliases();
    await f.discovery.prepare([f.pane], liveSignal());
    expect(f.runAsync).not.toHaveBeenCalled();
    expect(f.installed.size).toBe(0);
  });
  it("a known token cannot trigger reconciliation for a different session or semantic claim", async () => {
    const f = fixture();
    await f.discovery.prepare([f.pane], liveSignal());
    const token = f.installed.get("%1");
    expect(f.authority.resolveBinding(token, "other-session", "pane.one")).toBeNull();
    expect(f.authority.resolveBinding(token, "session", "forged-pane")).toBeNull();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("empty adoption followed by a fresh binding lifetime retries reconciliation", async () => {
    const f = fixture();
    await f.discovery.prepare([f.pane], liveSignal());
    await f.discovery.prepare([], liveSignal());
    await f.discovery.prepare([{ ...f.pane, paneLifetimeId: "fresh-after-empty" }], liveSignal());
    expect(f.runAsync).toHaveBeenCalledTimes(3);
  });
  it("a replacement lifetime is reconciled and the removed pane's token is rejected", async () => {
    const f = fixture();
    await f.discovery.prepare([f.pane], liveSignal());
    const previous = f.installed.get("%1");
    f.setRows([["%2", "pane.one"]]);
    await f.discovery.prepare(
      [{ ...f.pane, runtimePaneId: "%2", paneLifetimeId: "replacement" }],
      liveSignal(),
    );
    expect(f.authority.resolveBinding(previous, "session", "pane.one")).toBeNull();
    expect(f.installed.get("%2")).toBeTruthy();
  });
  it("retirement aborts a delayed inventory before it can install a grant", async () => {
    const f = fixture();
    let release!: (rows: string) => void;
    f.runAsync.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.discovery.prepare([f.pane], liveSignal());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.authority.dispose();
    release("%1\tpane.one\t");
    await expect(pending).rejects.toThrow();
    expect(f.installed.size).toBe(0);
    expect(f.runAsync).toHaveBeenCalledTimes(1);
  });
});
