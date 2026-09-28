# Experimental native interaction journal wire v2

Disabled by default; enable explicitly on a live server with `tmux-ide-events -e`.
Probe that same server with `-V`. An executable's version alone proves nothing
about the running server. No user-server migration is required.

`-i` returns the original connection identity and server epoch. Read it on the
same control connection used by a viewer, not via a separate CLI subprocess.
Connection identity proves a tmux transport connection, not a human, agent,
process ancestry, or source pane. No client-supplied PID/environment is trusted.

Read using `-r -E JOURNAL_UUID -a LAST_SEQUENCE [-n LIMIT]`; `-w` atomically waits
when caught up. Maximum batch256, readers4, ring4096. Daemon readers should request
64 because their subprocess output limit is64KiB. All uint64 values are decimal
strings; UUID epochs are v4. Wrong epoch returns `type: reset`. Overflow reports
an inclusive missing sequence `gap: {from, through}`; resume using `next`.

Example record inside a `type: batch` response:

```json
{
  "sequence": "1",
  "commandId": "3",
  "issuerId": "5",
  "monotonicUs": "834952100",
  "count": "0",
  "targetId": 0,
  "kind": 1,
  "outcome": 1,
  "flags": 1,
  "requestId": "7",
  "parentCommandId": "0",
  "transport": 1,
  "derivation": 0
}
```

`command-outcome-v1` covers command dispatch outcomes only:

- Kind:1 send-keys,2 capture-pane,3 paste-buffer,4 send-prefix.
- Outcome:1 completed,2 rejected,3 waiting; none means application consumption.
- Flags:1 resolved target,2 send-X,4 send-K,8 send-R,16 send-M,32 capture-R.
- Transport:0 unknown/internal,1 CLI connection,2 control connection.
- Derivation:0 direct/unknown,1 native child,2 hook,3 native background child.
- Zero issuer/request/parent means unavailable. `targetId:0` is a valid pane only
  when flag1 is set. `count` is zero for command records, never inferred bytes.

IDs are scoped to `serverEpoch`. Request IDs group one ingress command list;
command IDs distinguish dispatches. A parent can refer to an unrecorded command
(e.g. source-file, if-shell, run-shell). Deferred native commands copy scalar
origin metadata before the parent can disappear. A shell subprocess invoking
raw tmux creates a new connection; this does not prove parentage. Notification
hooks without captured ingress remain unknown, even if tmux borrows a viewer
client to execute them. Key bindings and other untracked ingress also remain
unknown. This is deliberately not universal actor attribution.

The journal does not retain command arguments, input text, captured output,
buffer text, environment, or error strings. Producer append uses fixed storage
and schedules a coalesced wake. Allocation failure, overflow and disconnect do
not reject terminal input. As with any in-process C extension, memory corruption
could affect the server; sanitizer qualification is mandatory.

Capability and batch responses contain a monotonic `degraded` bitmask:0 healthy,
1 command identity exhausted,2 connection identity exhausted,4 request identity
exhausted. Exhausted IDs remain0 (unknown), never reused; command outcomes keep
recording. A newly degraded condition wakes waiting readers. A degraded `-w`
returns immediately: consumers must surface degradation and stop their normal
healthy wait loop (or use a bounded backoff), rather than spin. Server restart is
required to restore full identity coverage. The terminal path remains usable.

## Command effects

`pty-enqueue-v1` measures bytes appended synchronously to the target PTY output
buffer during send-keys/send-prefix/paste-buffer execution. Kind5 records carry
that byte count. This is not kernel delivery or application consumption. It does
not claim coverage of ordinary keyboard ingress outside these command contexts.

`capture-produced-v1` records kind6 with produced payload bytes after successful
capture output/store; it does not prove anybody read those bytes. Kind5/6 share
their commandId and origin with the separate command outcome. Effect records
flush before the outcome; consumers must not depend on adjacency. Count0 on a
command record still means no inferred effect count.

Aggregation is fixed at64 unique (pane,kind) slots per command. More fanout,
nested synchronous observation or count overflow sets degraded bit8. Recorded
counts then represent only observed portions, not completeness. Input continues
for all targets; no per-key allocations, content logging, or serialization occur
in the observer. Unknown key-binding ingress stays unknown.

## Cooperative operation assertion

`cooperative-operation-v1` provides `tmux-ide-run -O UUID { commands }`. The
wrapper works with observation disabled and never supplies/replaces issuerId.
Records add `correlation: UUID | null`. Explicit native descendants (including
hooks and delayed commands) inherit it; new external subprocess connections do
not. Nested explicit wrappers may replace the assertion.

A UUID alone proves nothing. To bind an authored operation, the daemon must
match serverEpoch and nonzero issuerId against the identity handshake on its
own same control connection, then validate the expected operation. A different
connection can assert the same UUID but cannot acquire that connection ID. Do
not blanket-discard every effect with a matched correlation: hooks can perform
additional real actions. Preserve command/effect lineage and operation scope.

No mutable pane marker or claimed process ID participates in this mechanism.
The wrapper is cooperative metadata, not a security boundary against other
processes running as the same OS user.

## Wire version2: immutable pane identity

All capability/read/reset/identity responses now use schemaVersion2 and capability
adds `pane-identity-v1`. Version1 readers must reject this capability. Every record
includes `targetBirthId` as a uint64 decimal string;0 means unavailable. The
existing targetId remains a numeric tmux address, never a lifetime identity.

A birth counter is allocated for every new pane even while observation is off.
It remains stable across join/break/link operations and respawn, and is scoped by
serverEpoch rather than journalEpoch. The read-only `#{pane_birth_id}` format
exposes it for current inventory aliases. No session/workspace at observation time
is implied. Counter exhaustion returns0, sets degraded bit16, wakes readers and
still permits pane creation and terminal input. The qualification-only -B option
forces exhaustion and is absent from production builds.

The fixed record gains one uint64 scalar (128bytes,524296byte ring); synchronous
64target aggregation additionally retains each actual pane birth identity. No
per-event allocation or content logging is introduced.

## Optional sessionless control reader

Capability optionally advertises `readerTransport: "sessionless-control-v1"`.
The daemon may then launch `tmux -N -C -S SOCKET tmux-ide-events -P` after a
same-live-server capability probe/explicit enable. Only that exact initial argv
pair on ordinary `-C` can park; `-CC`, disabled journals and unavailable connection
identity cannot. No `MSG_READY` or terminal attachment occurs. At most4parked
readers exist, independently of the existing4waiter slots.

The initial normal control `%begin`/`%end` frame contains exactly two JSON lines:
capability followed by the existing wire2 identity response. Both share the live
serverEpoch; connectionId is the actual original connection. Later input is only
`read JOURNAL_UUID UINT64_CURSOR LIMIT WAIT\n`, where LIMIT is1..64 and WAIT0or1.
Tokens are canonical lowercase UUID/decimal strings with exactly single spaces.
Each accepted request has one normal control response frame. Repeated parking,
ordinary tmux commands, separators, expansions and pipelining are rejected before
caller text can reach the general command parser. The implementation constructs
only a fixed journal-read command from validated scalar tokens.

Input has a128byte high watermark; one request may be in flight. During a wait,
readability is solely a bounded cancellation/violation detector: empty line/EOF
closes, any second request closes. Completed responses disable reading until the
actual output buffer drains; the write callback rearms it. Output has a64KiB hard
ceiling, batches at most64records, and no global control notifications or pane
output are emitted to the parked reader. Closing cancels its waiter; a stopped
consumer cannot accumulate a command queue. Killing the helper remains the
bounded cancellation fallback when output backpressure has disabled stdin reads.

Parked readers do not keep an otherwise empty/exiting server alive. They have no
session, attached-client count or resize participation. The internal reader flag
cannot be claimed via client identification flags. This mode is a journal reader,
not a general control transport or authenticated agent identity.

Both the initial `-P` parse and translated reads explicitly disable tmux command
aliases. Parked read errors do not run user `command-error` hooks. A waiting read
keeps its `%begin` frame open; the native wake callback emits JSON then `%end`,
so no delayed record escapes its request frame. Embedded NUL bytes are rejected
using the actual input-line byte length.

Before the initial command establishes the reader flag, ordinary tmux control
identification may race an unrelated global notification. Consumers must reject
unexpected handshake traffic and retry with bounded backoff; this is not valid
journal evidence. After parking, notifications are suppressed. This limitation
avoids changing startup behavior for ordinary control clients.

## Strict owned-operation acknowledgement

Capability optionally advertises `ownedOperationTransport: "direct-wrapper-v1"`.
With that capability, `tmux-ide-run -I -O UUID 'COMMAND STRING'` emits one private
wire2 acknowledgement before executing children:

```json
{
  "schemaVersion": 2,
  "type": "operation-identity",
  "serverEpoch": "UUID",
  "connectionId": "UINT64",
  "wrapperCommandId": "UINT64",
  "operationId": "UUID"
}
```

`-I` requires enabled observation, a positive command ID, and an actual originating
connection whose ID matches the immutable issuer. Otherwise it errors before
executing children. It accepts only a string body, parsed explicitly without
command aliases or parse-time global environment assignments. A braced/preparsed command list is rejected without executing its child commands: aliases might
already have inserted additional commands before the wrapper executes. Ordinary
non-`-I` wrapper behavior is unchanged.

The exact registered names `tmux-ide-events` and `tmux-ide-run` bypass user alias
expansion in every parser context, including nested guarded commands. All other
ordinary aliases retain their usual behavior. Strict `-I` bodies also bypass
ordinary aliases during their direct parse, so an alias for `send-keys` cannot
inject extra direct commands under the acknowledged wrapper.

The acknowledgement is not evidence that input was consumed or that an agent
performed it. An owned binding must match serverEpoch, connectionId, operationId
and the native record's parentCommandId against wrapperCommandId, together with
its admitted target/effect policy. Hook descendants may preserve correlation and
issuer and regain a `child` derivation through if-shell; their immediate parent
still differs. They must not be suppressed as intended direct operations.

The no-child-execution guarantee does not undo parsing that tmux already performed
outside the private string body. Ordinary `command-error` hooks can still run on
an invalid owned wrapper; their effects are separate observations and do not gain
direct-child ownership proof. The daemon must construct the string from known
command/argument arrays with literal escaping, not accept arbitrary scripts.

### Native server-epoch guard

The optional capability `ownedOperationEpochGuard: "server-epoch-v1"` adds
`tmux-ide-run -I -E SERVER_EPOCH -O OPERATION_UUID 'COMMAND STRING'`. The expected
server epoch must match the server's immutable lifetime UUID. It is checked
before parsing the string body, enqueueing children, or printing the wrapper
acknowledgement. `-E` without `-I`, malformed UUIDs, and stale epochs fail without
executing the supplied body. Ordinary tmux command-error hooks retain their
usual behavior; this does not suppress unrelated user hooks.

A daemon can therefore use its pinned raw socket runner for this guarded native
extension without an ordinary `if-shell` command around the operation. It must
require this capability before dispatch. Existing wrapper forms, schemas, and
ordinary command aliases remain unchanged. Server lifetime validation does not
by itself guard pane lifetime between individual child commands.

### Direct-child pane lifetime guard

The optional capability `ownedOperationPaneGuard: "direct-pane-v1"` adds paired
`-t %RAW_PANE_ID -B POSITIVE_BIRTH_ID` arguments to the strict `-I -E` wrapper.
Both are required together. The wrapper validates the physical pane before
parsing its body, then copies the expected ID, birth, and wrapper command ID
into immutable child origin metadata. Immediately before each direct child
executes, tmux verifies that physical pane still exists with that birth. For
commands whose declared target is a pane, the resolved target must be that
same pane. Guarded `send-keys -K` and `-M` are refused because they can redirect
input beyond that target contract. Failure stops the remaining command group.

This check is repeated after a preceding child hook yields. It also precedes
non-pane children such as set-buffer. No event-loop yield occurs between the
check and synchronous command execution. Moving or linking the same physical
pane preserves birth and is permitted; semantic workspace membership is not
part of this native guarantee. Hook and background descendants have different
immediate parents and retain ordinary tmux behavior. Nested commands are not
silently claimed to be direct guarded children.

Synchronization can enqueue input to multiple panes inside one send command.
The guard applies to its direct resolved target; every resulting physical
PTY effect remains separately observed. Owned attribution must match the exact
expected birth; other synchronized targets remain independent evidence.
