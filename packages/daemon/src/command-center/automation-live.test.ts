import { Hono } from "hono";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mountAutomationRoutes } from "./automation.ts";
import {
  createNativeTmuxServerOwner,
  type NativeTmuxServerOwner,
} from "../lib/tmux-server-owner.ts";
import { TmuxServerOwners } from "../lib/tmux-server-owners.ts";
import { createTmuxServerProbe } from "../lib/tmux-server-registration.ts";
import {
  PANE_SOURCE_CREDENTIAL_OPTION,
  PANE_SOURCE_CREDENTIAL_HEADER,
} from "../lib/pane-source-credentials.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
it.skipIf(!hasTmux)(
  "automation resolves two real owners, sends once and returns one exact private read",
  async () => {
    const root = mkdtempSync("/tmp/tmux-automation-");
    const executablePath = realpathSync(
      execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(),
    );
    const sockets = [join(root, "a.sock"), join(root, "b.sock")];
    const run = (socket: string, args: string[]) =>
      execFileSync(executablePath, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      }).trim();
    const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
      probe: createTmuxServerProbe(executablePath),
      create: (registration, scope, observation) =>
        createNativeTmuxServerOwner({
          ...scope,
          environmentId: "00000000-0000-4000-8000-000000000001",
          tmuxAuthority: observation.authority,
          nativeServerIdentity: observation.nativeServerIdentity,
          stateDirectory: join(root, registration.serverId),
          webSocketUrl: "ws://127.0.0.1:45678/v2/terminal/pane-streams/redeem",
        }),
    });
    try {
      for (const socket of sockets) {
        run(socket, ["new-session", "-d", "-s", "shared", "cat"]);
        run(socket, ["set-option", "-p", "-t", "shared:0.0", "@tmux_ide_pane_id", "pane.shared"]);
        await owners.register({ label: "test", selector: { kind: "path", path: socket } });
      }
      const app = new Hono();
      mountAutomationRoutes(app, { ownerToken: "owner", owners });
      const request = (path: string, body?: unknown, credential?: string) =>
        app.request("/api/v1/automation" + path, {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer owner",
            ...(credential ? { [PANE_SOURCE_CREDENTIAL_HEADER]: credential } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const { panes } = await (await request("/panes")).json();
      expect(panes).toHaveLength(2);
      const sourceCredential = run(sockets[1]!, [
        "show-options",
        "-p",
        "-v",
        "-t",
        "shared:0.0",
        PANE_SOURCE_CREDENTIAL_OPTION,
      ]);
      const intent = {
        kind: "send",
        target: panes[0].endpoint,
        source: panes[1].endpoint,
        text: "automation-live-private",
        enter: true,
      };
      const reserve = await request("/reserve", { version: 1, intent }, sourceCredential);
      expect(reserve.status).toBe(201);
      const { handle } = await reserve.json();
      const first = await request("/execute", { version: 1, handle, intent }, sourceCredential);
      expect(first.status, await first.clone().text()).toBe(200);
      expect(
        (await request("/execute", { version: 1, handle, intent }, sourceCredential)).status,
      ).toBe(200);
      expect(run(sockets[0]!, ["capture-pane", "-p", "-t", "shared:0.0"])).toContain(
        "automation-live-private",
      );
      expect(run(sockets[1]!, ["capture-pane", "-p", "-t", "shared:0.0"])).not.toContain(
        "automation-live-private",
      );
      const readIntent = { kind: "read", target: panes[0].endpoint, source: null };
      const readHandle = (
        await (await request("/reserve", { version: 1, intent: readIntent })).json()
      ).handle;
      const readRequest = { version: 1, handle: readHandle, intent: readIntent };
      const readResponse = await request("/execute", readRequest);
      expect(readResponse.status, await readResponse.clone().text()).toBe(200);
      const snapshot = await readResponse.json();
      expect(snapshot.read.text).toContain("automation-live-private");
      expect((await (await request("/execute", readRequest)).json()).read).toEqual({
        availability: "replay-unavailable",
        text: null,
      });
      const status = await (
        await request(`/operations/${readHandle.generation}/${readHandle.operationId}`)
      ).json();
      expect(status.status).toBe("completed");
      expect(JSON.stringify(status)).not.toContain("automation-live-private");
    } finally {
      await owners.dispose();
      for (const socket of sockets)
        spawnSync(executablePath, ["-S", socket, "kill-server"], {
          stdio: "ignore",
          env: { ...process.env, TMUX: "" },
        });
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
