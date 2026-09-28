# Experimental native interaction journal v1

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
