import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NativeJournalControlConnection } from "./native-journal-control-connection.ts";

const epoch = "00000000-0000-4000-8000-000000000001";
const journal = "00000000-0000-4000-8000-000000000002";
const cursor = { serverEpoch: epoch, journalEpoch: journal, sequence: "0" };
const capability = {
  schemaVersion: 2,
  type: "capability",
  serverEpoch: epoch,
  journalEpoch: journal,
  enabled: true,
  coverage: [
    "command-outcome-v1",
    "pty-enqueue-v1",
    "capture-produced-v1",
    "cooperative-operation-v1",
    "pane-identity-v1",
  ],
  capacity: 4096,
  maxBatch: 256,
  maxWaiters: 4,
  waitingReaders: 0,
  degraded: 0,
  readerTransport: "sessionless-control-v1",
};
function fixture(mode = "normal", replyMs = 5000) {
  const directory = mkdtempSync(join(tmpdir(), "native-control-unit-"));
  const binary = join(directory, "peer");
  const pidPath = join(directory, "pid");
  const identity = {
    schemaVersion: 2,
    type: "identity",
    serverEpoch: mode === "foreign" ? journal : epoch,
    connectionId: "8",
  };
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const {createInterface}=require('node:readline');
require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));
const mode=${JSON.stringify(mode)};
if(mode==='stubborn')process.on('SIGTERM',()=>{});
process.stdout.write('%begin 1 1 0\\n'+${JSON.stringify(JSON.stringify(capability))}+'\\n'+${JSON.stringify(JSON.stringify(identity))}+'\\n%end 1 1 0\\n');
let n=1;
createInterface({input:process.stdin}).on('line',line=>{
 if(mode==='stubborn')return;
 if(!line)process.exit(0);
 if(mode==='wait')return;
 n++;
 if(mode==='notify'){process.stdout.write('%sessions-changed\\n');return;}
 if(mode==='partial-begin'){process.stdout.write('%beg');return;}
 if(mode==='partial-payload'){process.stdout.write('%begin 2 '+n+' 1\\n{');return;}
 if(mode==='missing-end'){process.stdout.write('%begin 2 '+n+' 1\\n{}\\n');return;}
 if(mode==='trickle'){process.stdout.write('%begin 2 '+n+' 1\\n{');setInterval(()=>process.stdout.write(' '),100);return;}
 if(mode==='parked'){
   process.stdout.write('%begin 2 '+n+' 1\\n');
   setTimeout(()=>process.stdout.write(JSON.stringify({request:line})+'\\n%end 2 '+n+' 1\\n'),1800);
   return;
 }

 const body=mode==='oversize'?'x'.repeat(65537):JSON.stringify({request:line});
 const end=mode==='guard'?n+1:n;
 process.stdout.write('%begin 2 '+n+' 1\\n'+body+'\\n%end 2 '+end+' 1\\n'+(mode==='trailing'?'%sessions-changed\\n':''));
});
`,
    { mode: 0o755 },
  );
  const connection = new NativeJournalControlConnection(
    { executablePath: binary, socketSelector: { kind: "path", path: join(directory, "socket") } },
    epoch,
    replyMs,
  );
  return {
    connection,
    pid: () => Number(readFileSync(pidPath, "utf8")),
    async close() {
      await connection.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("bounded sessionless native connection", () => {
  it("reuses one peer for sequential reads and retains its actual identity", async () => {
    const f = fixture();
    try {
      await f.connection.start(AbortSignal.timeout(2000));
      const pid = f.pid();
      expect(f.connection.connectionId).toBe("8");
      for (const sequence of ["0", "1", "18446744073709551615"])
        expect(
          JSON.parse(await f.connection.read({ ...cursor, sequence }, AbortSignal.timeout(2000))),
        ).toEqual({ request: `read ${journal} ${sequence} 64 1` });
      expect(f.pid()).toBe(pid);
      await f.connection.dispose();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await f.close();
    }
  });
  it("rejects a different incarnation before any read", async () => {
    const f = fixture("foreign");
    try {
      await expect(f.connection.start(AbortSignal.timeout(2000))).rejects.toThrow("incarnation");
    } finally {
      await f.close();
    }
  });
  it.each(["guard", "notify", "oversize", "trailing"])(
    "closes on %s protocol violations",
    async (mode) => {
      const f = fixture(mode);
      try {
        await expect(f.connection.read(cursor, AbortSignal.timeout(2000))).rejects.toThrow(
          "protocol",
        );
        expect(() => process.kill(f.pid(), 0)).toThrow();
      } finally {
        await f.close();
      }
    },
  );
  it("has no request queue and cancellation reaps a blocked peer", async () => {
    const f = fixture("wait");
    const abort = new AbortController();
    try {
      await f.connection.start(AbortSignal.timeout(2000));
      const pending = f.connection.read(cursor, abort.signal);
      await Promise.resolve();
      await expect(f.connection.read(cursor, AbortSignal.timeout(2000))).rejects.toThrow(
        "in flight",
      );
      abort.abort();
      await expect(pending).rejects.toThrow("cancelled");
      expect(() => process.kill(f.pid(), 0)).toThrow();
    } finally {
      await f.close();
    }
  });
  it.each(["wait", "partial-begin", "partial-payload", "missing-end", "trickle"])(
    "bounds %s framing without waiting for lifetime cancellation",
    async (mode) => {
      const f = fixture(mode, 750);
      try {
        await f.connection.start(AbortSignal.timeout(2000));
        await expect(f.connection.read(cursor, new AbortController().signal)).rejects.toThrow(
          "phase deadline",
        );
        expect(() => process.kill(f.pid(), 0)).toThrow();
        await expect(f.connection.read(cursor, new AbortController().signal)).rejects.toThrow();
      } finally {
        await f.close();
      }
    },
  );
  it("keeps a valid begun event wait on the same peer beyond reply deadlines", async () => {
    const f = fixture("parked", 750);
    try {
      await f.connection.start(AbortSignal.timeout(2000));
      const pid = f.pid();
      expect(JSON.parse(await f.connection.read(cursor, new AbortController().signal))).toEqual({
        request: `read ${journal} 0 64 1`,
      });
      expect(f.pid()).toBe(pid);
      expect(f.connection.connectionId).toBe("8");
    } finally {
      await f.close();
    }
  });
  it("reaps a peer that ignores graceful shutdown and SIGTERM", async () => {
    const f = fixture("stubborn");
    try {
      await f.connection.start(AbortSignal.timeout(2000));
      const pid = f.pid();
      await f.connection.dispose();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await f.close();
    }
  });
});
