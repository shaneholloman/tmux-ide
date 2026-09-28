import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import {
  DaemonEventServerFrameSchemaZ,
  type DaemonEventServerFrame,
  type InteractionReceipt,
} from "@tmux-ide/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { createAutomationClient } from "@tmux-ide/daemon-client/automation-client";
import { send } from "../../send.ts";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { PANE_SOURCE_CREDENTIAL_OPTION } from "../pane-source-credentials.ts";
import { INTERNAL_SEND_OPERATION_OPTION } from "../tmux-external-interaction-observer.ts";
import {
  _setDefaultWorkspaceRegistryForTests,
  getDefaultWorkspaceRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasTmux).sequential("authenticated pane provenance, full daemon", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-m56-provenance-"));
  const socketPath = join(root, "tmux.sock");
  const session = basename(root);
  const workspaceName = "workspace.m56-provenance";
  const ownerToken = `owner-${randomUUID()}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;
  let sourcePane = "";
  let targetPane = "";

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  beforeAll(() => {
    for (const name of [
      "TMUX",
      "TMUX_PANE",
      "TMUX_IDE_DAEMON_INFO_DIR",
      "TMUX_IDE_REGISTRY_DIR",
      "TMUX_IDE_SETTINGS_DIR",
      "TMUX_IDE_HOME",
      "TMUX_IDE_SESSION",
    ]) {
      previousEnvironment[name] = process.env[name];
    }
    process.env.TMUX_IDE_DAEMON_INFO_DIR = join(root, "daemon");
    process.env.TMUX_IDE_REGISTRY_DIR = join(root, "registry");
    process.env.TMUX_IDE_SETTINGS_DIR = join(root, "settings");
    process.env.TMUX_IDE_HOME = join(root, "home");
    delete process.env.TMUX_IDE_SESSION;

    sourcePane = run([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      session,
      "-n",
      "work",
    ]);
    targetPane = run(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:0`]);
    run(["select-pane", "-t", sourcePane, "-T", "Editor"]);
    run(["select-pane", "-t", targetPane, "-T", "Tests"]);
    run(["set-option", "-p", "-t", sourcePane, "@ide_name", "Editor"]);
    run(["set-option", "-p", "-t", targetPane, "@ide_name", "Tests"]);
    run(["set-option", "-p", "-t", sourcePane, "@tmux_ide_pane_id", "pane.editor"]);
    run(["set-option", "-p", "-t", targetPane, "@tmux_ide_pane_id", "pane.tests"]);
    process.env.TMUX = `${socketPath},${process.pid},0`;
    process.env.TMUX_PANE = sourcePane;

    const registry = new WorkspaceRegistry({
      dir: join(root, "registry"),
      listSessions: () => [session],
    });
    registry.add({ name: workspaceName, sessionName: session, projectDir: root });
    _setDefaultWorkspaceRegistryForTests(registry);
  });

  afterAll(async () => {
    await handle?.stop({ gracefulMs: 100 }).catch(() => undefined);
    handle = null;
    _setDefaultWorkspaceRegistryForTests(null);
    spawnSync(executablePath, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const start = async (): Promise<EmbeddedDaemonHandle> => {
    const started = await startEmbeddedDaemon({
      sessionName: session,
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });
    handle = started;
    return started;
  };

  function eventClient(daemon: EmbeddedDaemonHandle) {
    const socket = new WebSocket(`${daemon.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const frames: DaemonEventServerFrame[] = [];
    const waiters = new Set<() => void>();
    socket.on("message", (data: unknown) => {
      const parsed = DaemonEventServerFrameSchemaZ.safeParse(JSON.parse(String(data)));
      if (!parsed.success) return;
      frames.push(parsed.data);
      for (const notify of [...waiters]) notify();
    });
    const waitFor = (
      predicate: (frame: DaemonEventServerFrame) => boolean,
      timeoutMs = 15_000,
    ): Promise<DaemonEventServerFrame> =>
      new Promise((resolve, reject) => {
        const check = () => {
          const frame = frames.find(predicate);
          if (!frame) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(frame);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error("timed out waiting for daemon event"));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    return { socket, frames, waitFor };
  }

  it("runs the real CLI send path, emits honest receipts, and rotates authority on restart", async () => {
    const first = await start();
    // An explicit session launch must preserve its already configured workspace,
    // not create a second alias that makes immutable stock observations ambiguous.
    expect(
      getDefaultWorkspaceRegistry()
        .list()
        .filter((entry) => entry.sessionName === session),
    ).toMatchObject([{ name: workspaceName, sessionName: session }]);
    const events = eventClient(first);
    await new Promise<void>((resolve, reject) => {
      events.socket.once("open", resolve);
      events.socket.once("error", reject);
    });
    await events.waitFor((frame) => frame.type === "hello");

    const oldCredential = run([
      "display-message",
      "-p",
      "-t",
      sourcePane,
      `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
    ]).trim();
    expect(oldCredential).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const marker = `M56_CLI_${randomUUID().slice(0, 8)}`;
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await send(root, { to: "Tests", message: `printf '${marker}\\n'` });
    } finally {
      consoleLog.mockRestore();
    }
    await vi.waitFor(() => {
      expect(run(["capture-pane", "-p", "-t", targetPane])).toContain(marker);
    });
    const observed = (await events.waitFor(
      (frame) =>
        frame.type === "interaction.receipt" &&
        frame.origin === "cli" &&
        frame.phase === "observed" &&
        frame.target.kind === "pane" &&
        frame.target.semanticPaneId === "pane.tests",
    )) as InteractionReceipt;
    expect(observed.sourceSemanticPaneId).toBe("pane.editor");
    expect(observed.evidence).toMatchObject({
      actor: { kind: "cooperative", bindingId: expect.any(String) },
      observation: { kind: "cooperative-completion", operationId: observed.operationId },
      endpoints: {
        source: {
          kind: "pane",
          workspaceName,
          semanticPaneId: "pane.editor",
          paneLifetimeId: expect.any(String),
        },
        destination: {
          kind: "pane",
          workspaceName,
          semanticPaneId: "pane.tests",
          paneLifetimeId: expect.any(String),
        },
      },
    });
    expect(observed.evidence!.endpoints.source!.environmentId).toBe(
      observed.evidence!.endpoints.destination.environmentId,
    );
    expect(observed.evidence!.endpoints.source!.serverScope).toEqual(
      observed.evidence!.endpoints.destination.serverScope,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      events.frames.filter(
        (frame) =>
          frame.type === "interaction.receipt" &&
          frame.target.kind === "pane" &&
          frame.target.semanticPaneId === "pane.tests" &&
          frame.origin === "external" &&
          frame.operationKind === "workspace.pane.send",
      ),
    ).toHaveLength(0);

    // A forged/stale product marker is not consumed by SessionRuntime. It must
    // fall through as honest external activity instead of suppressing UI.
    run([
      "set-option",
      "-p",
      "-t",
      targetPane,
      INTERNAL_SEND_OPERATION_OPTION,
      `${first.instanceId}:${randomUUID()}`,
    ]);
    run(["send-keys", "-t", targetPane, "-l", "--", "printf 'EXTERNAL_M56\\n'"]);
    run(["send-keys", "-t", targetPane, "Enter"]);
    const external = (await events.waitFor(
      (frame) =>
        frame.type === "interaction.receipt" &&
        frame.origin === "external" &&
        frame.operationKind === "workspace.pane.send" &&
        frame.target.kind === "pane" &&
        frame.target.semanticPaneId === "pane.tests",
    )) as InteractionReceipt;
    expect(external).toMatchObject({ phase: "observed", sourceSemanticPaneId: null });
    expect(external.evidence).toMatchObject({
      actor: { kind: "unknown", reason: "stock-hook" },
      observation: { kind: "stock-hook", command: "send-keys" },
      effect: { kind: "unknown" },
      endpoints: { source: null, destination: observed.evidence!.endpoints.destination },
    });

    events.socket.close();
    await first.stop({ gracefulMs: 500 });
    handle = null;
    expect(run(["has-session", "-t", session])).toBe("");

    process.env.TMUX_IDE_SESSION = session;
    const second = await start();
    expect(
      getDefaultWorkspaceRegistry()
        .list()
        .filter((entry) => entry.sessionName === session),
    ).toMatchObject([{ name: workspaceName, sessionName: session }]);
    const newCredential = run([
      "display-message",
      "-p",
      "-t",
      sourcePane,
      `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
    ]).trim();
    expect(newCredential).not.toBe(oldCredential);

    const staleMarker = `STALE_${randomUUID().slice(0, 8)}`;
    const response = await fetch(`${second.apiBaseUrl}/api/v2/action/workspace.pane.send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
        "X-Tmux-Ide-Pane-Source-Credential": oldCredential,
      },
      body: JSON.stringify({
        workspaceName,
        sourceSemanticPaneId: "pane.editor",
        semanticPaneId: "pane.tests",
        text: `printf '${staleMarker}\\n'`,
        submit: true,
        origin: "cli",
      }),
    });
    expect(await response.json()).toMatchObject({ ok: false });
    expect(run(["capture-pane", "-p", "-t", targetPane])).not.toContain(staleMarker);
    expect(run(["has-session", "-t", session])).toBe("");
  });
  it("sessionless daemon grants sources for newly TUI-discovered panes before their first automation call", async () => {
    await handle?.stop({ gracefulMs: 100 });
    handle = null;
    delete process.env.TMUX_IDE_SESSION;
    handle = await startEmbeddedDaemon({ localBypassToken: ownerToken, silent: true });
    const lateSession = `${session}-late`;
    const latePane = run(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", lateSession]);
    run(["set-option", "-p", "-t", latePane, "@tmux_ide_pane_id", "pane.late"]);
    getDefaultWorkspaceRegistry().add({
      name: "workspace.late",
      sessionName: lateSession,
      projectDir: root,
    });
    expect(
      run(["display-message", "-p", "-t", latePane, `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`]),
    ).toBe("");
    const tui = await fetch(
      `${handle.apiBaseUrl}/api/project/${encodeURIComponent(lateSession)}/terminal-runtime-inventory?version=1`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    expect(tui.status).toBe(200);
    const token = run([
      "display-message",
      "-p",
      "-t",
      latePane,
      `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`,
    ]);
    expect(token.length).toBeGreaterThan(30);
    const client = createAutomationClient({
      baseUrl: handle.apiBaseUrl,
      ownerToken,
      sourceCredential: token,
    });
    const panes = (await client.discover()).panes;
    const source = panes.find((pane) => pane.endpoint.semanticPaneId === "pane.late")!.endpoint;
    const target = panes.find((pane) => pane.endpoint.semanticPaneId === "pane.tests")!.endpoint;
    const intent = { kind: "read" as const, source, target };
    const { handle: operation } = await client.reserve(intent);
    expect((await client.execute(operation, intent)).read?.availability).toBe("available");
    const replacement = run(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", latePane]);
    run(["kill-pane", "-t", latePane]);
    run(["set-option", "-p", "-t", replacement, "@tmux_ide_pane_id", "pane.late"]);
    const updated = (await client.discover()).panes.find(
      (pane) => pane.endpoint.semanticPaneId === "pane.late",
    )!.endpoint;
    expect(updated.paneLifetimeId).not.toBe(source.paneLifetimeId);
    expect(
      run(["display-message", "-p", "-t", replacement, `#{${PANE_SOURCE_CREDENTIAL_OPTION}}`]),
    ).not.toBe(token);
    await expect(client.reserve({ ...intent, source: updated })).rejects.toMatchObject({
      code: "invalid-source",
    });
  });
});
