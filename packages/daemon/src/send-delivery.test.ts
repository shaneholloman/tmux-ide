import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  panes: vi.fn(),
  busy: vi.fn(),
  command: vi.fn(),
  text: vi.fn(),
  daemon: vi.fn(),
  alive: vi.fn(),
  dispatch: vi.fn(),
  identity: vi.fn(),
  workspaces: vi.fn(),
  tmuxArgs: vi.fn(),
}));
vi.mock("./lib/runtime-namespace.ts", () => ({ runtimeTmuxArgs: mocks.tmuxArgs }));
vi.mock("@tmux-ide/tmux-bridge", () => ({ getSessionState: mocks.state }));
vi.mock("./widgets/lib/pane-comms.ts", () => ({
  listSessionPanes: mocks.panes,
  getPaneBusyStatus: mocks.busy,
  sendCommand: mocks.command,
  sendText: mocks.text,
}));
vi.mock("node:child_process", () => ({ execFileSync: mocks.identity }));
vi.mock("./lib/config-context.ts", () => ({
  resolveProjectConfigContext: async () => ({ sessionName: "work" }),
}));
vi.mock("./lib/canonical-daemon.ts", () => ({
  readCanonicalDaemonInfo: mocks.daemon,
  isCanonicalDaemonAlive: mocks.alive,
}));
vi.mock("./lib/cli-action-bridge.ts", () => ({ tryDispatchAction: mocks.dispatch }));
vi.mock("./lib/workspace-registry.ts", () => ({
  getDefaultWorkspaceRegistry: () => ({ load: async () => {}, list: mocks.workspaces }),
}));
import { deliverMessage, resolvePane, send } from "./send.ts";
import type { PaneInfo } from "./widgets/lib/pane-comms.ts";

const pane: PaneInfo = {
  id: "%2",
  index: 0,
  name: "editor",
  title: "Claude editor",
  role: "lead",
  currentCommand: "claude",
  width: 80,
  height: 24,
  active: true,
  type: null,
};
let dir: string;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.tmuxArgs.mockImplementation((args: string[]) => args);
  vi.stubEnv("TMUX_PANE", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-delivery-"));
  mocks.state.mockReturnValue({ running: true });
  mocks.panes.mockReturnValue([pane]);
  mocks.busy.mockReturnValue("idle");
  mocks.daemon.mockReturnValue({ pid: 123 });
  mocks.alive.mockResolvedValue(true);
  mocks.identity.mockReturnValue("pane.editor\n");
  mocks.workspaces.mockReturnValue([{ name: "workspace", sessionName: "work" }]);
  mocks.dispatch.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const run = (message = "hello", noEnter = false) =>
  send(dir, { to: "editor", message, noEnter, json: true });

describe("send delivery authority", () => {
  it("scopes target stamps, source identity and credentials through delivery authority", async () => {
    vi.stubEnv("TMUX_PANE", "%7");
    mocks.tmuxArgs.mockImplementation((args: string[]) => ["-S", "/isolated/tmux.sock", ...args]);
    mocks.identity.mockImplementation((_binary, args: string[]) => {
      expect(args.slice(0, 2)).toEqual(["-S", "/isolated/tmux.sock"]);
      const format = args.at(-1)!;
      if (format.includes("source_credential")) return "a".repeat(43);
      if (format.includes("session_name")) return "work\tpane.source";
      return "pane.editor";
    });
    await run();
    expect(mocks.identity).toHaveBeenCalledTimes(3);
    expect(mocks.dispatch.mock.calls[0]![1]).toMatchObject({
      sourceSemanticPaneId: "pane.source",
      semanticPaneId: "pane.editor",
    });
    expect(mocks.dispatch.mock.calls[0]![2]).toMatchObject({
      sourcePaneCredential: "a".repeat(43),
    });
  });

  it.each(["missing daemon", "dead daemon", "unstamped pane", "unregistered workspace"])(
    "uses daemonless delivery only before dispatch: %s",
    async (condition) => {
      if (condition === "missing daemon") mocks.daemon.mockReturnValue(null);
      if (condition === "dead daemon") mocks.alive.mockResolvedValue(false);
      if (condition === "unstamped pane") mocks.identity.mockReturnValue("");
      if (condition === "unregistered workspace") mocks.workspaces.mockReturnValue([]);
      await run();
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.command).toHaveBeenCalledExactlyOnceWith("work", "%2", "hello");
    },
  );
  it.each(["no response", "transport error"])(
    "never falls back after an uncertain daemon operation: %s",
    async (failure) => {
      if (failure === "no response") mocks.dispatch.mockResolvedValue(null);
      else mocks.dispatch.mockRejectedValue(new Error("connection reset after delivery"));
      await expect(run()).rejects.toThrow();
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
      expect(mocks.command).not.toHaveBeenCalled();
      expect(mocks.text).not.toHaveBeenCalled();
    },
  );
  it("uses one explicit operation id and does not autostart a second authority", async () => {
    await run();
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      "workspace.pane.send",
      {
        workspaceName: "workspace",
        semanticPaneId: "pane.editor",
        text: "hello",
        submit: true,
        origin: "cli",
      },
      { cwd: dir, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), autostart: false },
    );
    expect(mocks.command).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
      ok: true,
      session: "work",
      target: { paneId: "%2" },
      message: "hello",
      sentViaFile: false,
    });
  });
  it.each([true, false])("preserves no-enter long text (daemon=%s)", async (daemon) => {
    if (!daemon) mocks.daemon.mockReturnValue(null);
    const message = "literal\n".repeat(30);
    await run(message, true);
    expect(readdirSync(dir)).toEqual([]);
    expect(mocks.command).not.toHaveBeenCalled();
    if (daemon)
      expect(mocks.dispatch.mock.calls[0]![1]).toMatchObject({ text: message, submit: false });
    else expect(mocks.text).toHaveBeenCalledExactlyOnceWith("work", "%2", message);
  });
  it.each([true, false])(
    "retains busy-agent multiline/file behavior (daemon=%s)",
    async (daemon) => {
      if (!daemon) mocks.daemon.mockReturnValue(null);
      mocks.busy.mockReturnValue("agent");
      const message = "one\n\ntwo ".repeat(30);
      await run(message);
      const files = readdirSync(join(dir, ".tasks", "dispatch"));
      expect(files).toHaveLength(1);
      const prepared = message.replace(/\n+/g, " ").trim();
      expect(readFileSync(join(dir, ".tasks", "dispatch", files[0]!), "utf8")).toBe(prepared);
      const trigger = `Read and execute: .tasks/dispatch/${files[0]}`;
      if (daemon)
        expect(mocks.dispatch.mock.calls[0]![1]).toMatchObject({ text: trigger, submit: true });
      else expect(mocks.command).toHaveBeenCalledExactlyOnceWith("work", "%2", trigger);
      expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
        message: prepared,
        warning: "agent_busy",
        sentViaFile: true,
      });
    },
  );
  it("rejects absent sessions and targets without sending", () => {
    mocks.state.mockReturnValue({ running: false });
    expect(() => deliverMessage({ session: "work", target: "editor", message: "hi" })).toThrow(
      'Session "work" is not running',
    );
    mocks.state.mockReturnValue({ running: true });
    expect(() => deliverMessage({ session: "work", target: "%99", message: "hi" })).toThrow(
      'Pane "%99" not found',
    );
    expect(mocks.command).not.toHaveBeenCalled();
  });
});

describe("existing target selection compatibility", () => {
  it("prefers exact identity/name/title over role and partial title", () => {
    const partial = { ...pane, id: "%1", name: null, title: "other editor", role: null };
    const title = { ...pane, id: "%3", name: null, title: "editor" };
    expect(resolvePane([partial, title, pane], "editor")).toBe(pane);
    expect(resolvePane([partial, title], "editor")).toBe(title);
    expect(resolvePane([partial, pane], "LEAD")).toBe(pane);
    expect(resolvePane([partial, pane], "EDITOR")).toBe(partial);
    expect(resolvePane([partial, pane], "%2")).toBe(pane);
    expect(resolvePane([partial, pane], "%99")).toBeNull();
  });
});
