import {
  PaneSourceCredentialAuthority,
  STARTUP_PANE_CREDENTIAL_TIMEOUT_MS,
} from "./pane-source-credentials.ts";

interface DiscoveredSourcePane {
  readonly sessionName: string;
  readonly runtimePaneId: string;
  readonly semanticPaneId: string | null;
  readonly paneLifetimeId: string | null;
}
/** Internal trusted-inventory hook; never accepts credentials or a caller's pane claim. */
export class PaneSourceDiscovery {
  readonly #authority: PaneSourceCredentialAuthority;
  readonly #workspaces: () => readonly { sessionName: string }[];
  readonly #fingerprints = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();
  constructor(
    authority: PaneSourceCredentialAuthority,
    workspaces: () => readonly { sessionName: string }[],
  ) {
    this.#authority = authority;
    this.#workspaces = workspaces;
  }
  prepare(panes: readonly DiscoveredSourcePane[], signal: AbortSignal): Promise<void> {
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(STARTUP_PANE_CREDENTIAL_TIMEOUT_MS),
    ]);
    const work = this.#tail.then(async () => {
      bounded.throwIfAborted();
      const counts = new Map<string, number>();
      for (const workspace of this.#workspaces())
        counts.set(workspace.sessionName, (counts.get(workspace.sessionName) ?? 0) + 1);
      const sessions = new Map<string, string[]>();
      for (const pane of panes) {
        if (!pane.semanticPaneId || !pane.paneLifetimeId || counts.get(pane.sessionName) !== 1)
          continue;
        const rows = sessions.get(pane.sessionName) ?? [];
        rows.push(JSON.stringify([pane.runtimePaneId, pane.semanticPaneId, pane.paneLifetimeId]));
        sessions.set(pane.sessionName, rows);
      }
      for (const [session, rows] of sessions) {
        bounded.throwIfAborted();
        const fingerprint = JSON.stringify(rows.sort());
        if (this.#fingerprints.get(session) === fingerprint) continue;
        await this.#authority.reconcileSessionAsync(session, bounded);
        bounded.throwIfAborted();
        // Aliases can change while tmux is awaited. Never cache an ambiguous adoption.
        if (
          this.#workspaces().filter((workspace) => workspace.sessionName === session).length !== 1
        ) {
          this.#fingerprints.delete(session);
          continue;
        }
        if (!this.#fingerprints.has(session) && this.#fingerprints.size >= 4096) {
          const oldest = this.#fingerprints.keys().next().value;
          if (oldest !== undefined) this.#fingerprints.delete(oldest);
        }
        this.#fingerprints.set(session, fingerprint);
      }
      for (const session of this.#fingerprints.keys())
        if (counts.get(session) !== 1) this.#fingerprints.delete(session);
    });
    // Serialize discovery passes so asynchronous reconciliation cannot mint two
    // competing grants for one physical pane. Failed passes are retried later.
    this.#tail = work.catch(() => undefined);
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(bounded.reason);
      if (bounded.aborted) {
        reject(bounded.reason);
        return;
      }
      bounded.addEventListener("abort", abort, { once: true });
      void work.then(
        () => {
          bounded.removeEventListener("abort", abort);
          resolve();
        },
        (error) => {
          bounded.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
}
