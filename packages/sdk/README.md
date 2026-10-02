# `@tmux-ide/sdk`

The host-neutral, renderer-safe tmux-ide client.

```ts
import { createTmuxIdeSdk } from "@tmux-ide/sdk";

const tmuxIde = createTmuxIdeSdk(window.tmuxIdeHost);
const bootstrap = await tmuxIde.bootstrap();
const workspaces = await tmuxIde.daemon.listWorkspaces();

// Generic and fully typed, useful for automation and contract tests.
const readiness = await tmuxIde.daemon.request({ resource: "startupReadiness" });
```

Non-desktop runtimes use the daemon-only factory instead of fabricating window,
theme, update, or onboarding capabilities:

```ts
import { createTmuxIdeDaemonSdk } from "@tmux-ide/sdk";

const daemon = createTmuxIdeDaemonSdk(myDaemonHostAdapter);
const workspaces = await daemon.listWorkspaces();
```

Owner automation can deliver privacy-safe pane input with a stable operation
ID. When the caller is itself a workspace pane, include its semantic identity;
the daemon publishes the relationship only after validating both pane stamps
against live tmux state:

```ts
import { createTmuxIdeOwnerSdk } from "@tmux-ide/sdk";

const owner = createTmuxIdeOwnerSdk({ baseUrl, ownerToken });
await owner.sendPane({
  workspaceName: "product",
  sourceSemanticPaneId: "pane.editor",
  semanticPaneId: "pane.tests",
  text: "Run the focused suite",
  submit: true,
});
```

Receipts never contain `text`. Authored sends expose the verified relationship
as `pane.editor → pane.tests`; raw external `tmux send-keys` remains source-less
and is presented as `External input → pane.tests`.

The SDK exposes the complete reviewed host capability surface. Named methods
validate requests while preserving each UI's semantic projection boundary; the
generic `daemon.request()` path additionally validates responses for automation
and integration tests. Bootstrap state and pushed events are always validated.
`createTmuxIdeDaemonSdk()` is the portable core used by TUI, browser, automation,
and test adapters; `createTmuxIdeSdk()` adds the real desktop-only capabilities.
Neither exposes an arbitrary HTTP, shell, IPC, or tmux-command escape hatch.
It also contains no canvas implementation or external canvas SDK; renderer and
layout concerns stay outside this host/daemon capability facade.

## Distribution and development

This repository can build and qualify a standalone ESM package; that does not
mean a standalone SDK version has been published. Run `pnpm --dir packages/sdk
build` to generate `dist/index.js` and one bundled `dist/index.d.ts`.
Use `pnpm --dir packages/sdk pack` to create the tarball: pnpm applies the
`publishConfig` entry overrides. Workspace consumers retain the source entry.
The distribution includes private workspace implementations in the bundle;
its only runtime package dependency is Zod. It requires a runtime with Fetch,
AbortSignal.timeout and crypto.randomUUID (or an explicit operation ID).

`pnpm --dir packages/sdk test:pack` builds, packs, installs into a temporary
project outside the repository, executes Node calls, runs strict TypeScript
without skipLibCheck, and bundles an external browser consumer. It does not
publish or connect to a daemon. The build uses the TypeScript compiler followed
by pinned Rollup and rollup-plugin-dts for declarations.

## Owner delivery failures

Owner calls require an explicit owner token. Treat that token as a credential;
do not embed it in a public website. The optional `fetch` argument supports a
host adapter or testing without an implicit connection.

`sendPane` uses one operation ID across at most two transport attempts. The
`timeoutMs` setting defaults to 2,000 milliseconds **per attempt**. A well-formed
daemon refusal is thrown immediately, preserving `code`, `message`, and
`details`; it is never retried. Lost responses or malformed responses may be
retried with the same ID. If neither attempt confirms delivery, the error
identifies the operation and delivery is not repeated through raw tmux. This
is not an exactly-once guarantee across daemon restarts.
