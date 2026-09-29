# Physical Spark retained TUI observer

This is an opt-in extension of the prepared-owner Home recovery fixture. It does
not create a second physical setup or replace the remote daemon twice. Both the
Home observer and the retained terminal observer use one reviewed canonical
config and the driver's existing `replace-owner` action.

After source/build review and preparation of both exact managed leases, run:

```sh
SPARK_RECOVERY_CONFIG=/absolute/private/config.json \
SPARK_RETAINED_TUI=1 \
pnpm exec vitest run --config scripts/lib/spark-recovery-vitest.config.ts
```

Do not run this concurrently with latency/CPU qualification. A missing config
skips the physical test; that skip is not qualification. The local host must be
macOS with the fixture's kernel process-witness prerequisites. Freeze the manager
source, local compiled TUI/build manifest, remote source/native artifacts, Node,
Bun and SSH config before running. The prepared local and remote owners must
already expose the private `attribution-collision` session and `pane.shared`.

The observer uses the verified local immutable TUI build in two real PTYs. It
records ordinary managed-app child receipts under the existing lifecycle lock;
it never calls owner `up`, `rebuild` or default daemon discovery. One PTY selects
the physical remote via the production `--ssh` path, the other keeps the local
sibling usable. A task-private PATH wrapper only translates the exact production
SSH discovery and loopback-forward argv using `sparkQualificationSshArgs`; it
invokes system SSH with the reviewed private config and no shared master/agent.
Each invocation rereads the current private expected lease. No production
transport or application code is replaced.

Before disruption, after killing the exact owned TUI forward, and after the
shared remote daemon replacement, the same TUI PID/kernel birth must consume
encoded shell output and newly typed input. Whole output markers use octal
printf encoding so an echoed command cannot pass as application output. A short
private reconnect hold permits a local-sibling input check while the TUI's
remote forward is absent. The hold returns the normal unavailable handshake
vocabulary; it never changes the remote endpoint. Reconnection uses real SSH.

`retained-tui-result.json` is independent of `recovery-result.json`. It includes
stage frames/hashes, parsed chunk progress, retained PTY identity, forward
retirement/replacement facts and cleanup. Its boundary is real PTY input through
the product transport to parsed TUI output. It is neither optical/display
latency nor the Home model's activity replay. The Home result continues to state
`retainedTuiQualified: false`; only the separate observer may establish that proof.

Cleanup closes both PTYs and kernel-tracked descendants, then verifies every
recorded SSH child and wrapper is absent before removing its own managed app
receipts. Missing/ambiguous admission or PID reuse refuses cleanup; no broad kill
or reset is permitted. Task-private route and diagnostic files remain evidence.
The outer driver still owns final managed-owner cleanup and must retain its
receipts. A failed retained result must not be converted into a Home-only pass.
