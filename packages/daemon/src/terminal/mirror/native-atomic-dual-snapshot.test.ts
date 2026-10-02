import { expect, it } from "vitest";
import {
  decodeNativeAtomicSnapshot,
  decodeNativeAtomicDualSnapshot,
  nativeAtomicDualSnapshotPlan,
} from "./native-atomic-snapshot.ts";
import { PaneFeed } from "./pane-feed.ts";
const target = {
  serverEpoch: "00000000-0000-4000-8000-000000000001",
  paneId: "%0",
  paneBirthId: "1",
};
const cursor = "1 0 2 1 0 1 0 0 0 0 0 0 0 1 0 2000 0 0 0 0 0 0 on";
function records(bytes = Buffer.from("A\n")): unknown[] {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 4096)
    chunks.push({ ansiHex: bytes.subarray(i, i + 4096).toString("hex") });
  return [
    { ...target, snapshotVersion: 2, representation: "dual", cursor, resumed: true },
    {
      version: 2,
      cols: 2,
      rows: 1,
      history: 0,
      hscrolled: 0,
      limit: 2000,
      cursor: [1, 0],
      currentAttributes: [0, 8, 8, 8],
    },
    { row: 0, flags: 0, used: 1, cells: [[0, 1, "41", 0, 8, 8, 8, 0, 0]] },
    ...chunks,
    { ansiEnd: true, bytes: bytes.length, chunks: chunks.length },
  ];
}
function reply(rows = records()) {
  return { ok: true, lines: [...rows.map((row) => JSON.stringify(row)), "%continue %0"] };
}
it("uses explicit dual capability plan and the entire v2 wire budget", () => {
  const plan = nativeAtomicDualSnapshotPlan(target, 10000);
  expect(plan.commands[0]).toEqual([
    "capture-pane",
    "-p",
    "-R",
    "-Q",
    "-D",
    "-U",
    "10000",
    "-S",
    "-",
    "-t",
    "%0",
  ]);
  expect(decodeNativeAtomicSnapshot(reply(), target)).toEqual({ status: "unknown" });
});
it.each([
  Buffer.alloc(0),
  Buffer.from("A\n"),
  Buffer.alloc(4097, 65),
  Buffer.from("\x1b[31m界\n%end 0\n%continue %0\n"),
])("decodes exact bounded bytes including empty and sentinel content", (bytes) => {
  const value = reply(records(bytes));
  const limit = value.lines.reduce((sum, line) => sum + line.length + 1, 0);
  const result = decodeNativeAtomicDualSnapshot(value, target, limit);
  expect(result.status).toBe("ok");
  if (result.status === "ok") expect(result.ansiCapture).toEqual(bytes);
  expect(decodeNativeAtomicDualSnapshot(value, target, limit - 1)).toEqual({ status: "unknown" });
});
it.each([
  { ansiHex: "" },
  { ansiHex: "AA" },
  { ansiHex: "a" },
  { ansiHex: "gg" },
  { ansiHex: "41", extra: true },
  { ansiHex: "41".repeat(4097) },
])("rejects malformed or oversized chunk %j", (chunk) => {
  const rows = records();
  rows[3] = chunk;
  expect(decodeNativeAtomicDualSnapshot(reply(rows), target)).toEqual({ status: "unknown" });
});
it("rejects reordered, duplicate, uncounted and short nonfinal chunks", () => {
  const base = records();
  const cases = [
    [base[0], base[1], base[3], base[2], base[4]],
    [...base, base[4]],
    [...base.slice(0, 4), { ansiEnd: true, bytes: 9, chunks: 1 }],
    [
      ...base.slice(0, 3),
      { ansiHex: "41" },
      { ansiHex: "42" },
      { ansiEnd: true, bytes: 2, chunks: 2 },
    ],
    [...base.slice(0, 3), { ansiEnd: true, bytes: 0, chunks: 0 }, base[3]],
  ];
  for (const rows of cases)
    expect(decodeNativeAtomicDualSnapshot(reply(rows), target)).toEqual({ status: "unknown" });
});
it("rejects foreign scope, failure and separately delivered continuation", () => {
  expect(decodeNativeAtomicDualSnapshot(reply(), { ...target, paneBirthId: "2" })).toEqual({
    status: "unknown",
  });
  expect(decodeNativeAtomicDualSnapshot({ ...reply(), ok: false }, target)).toEqual({
    status: "unknown",
  });
  expect(
    decodeNativeAtomicDualSnapshot({ ok: true, lines: reply().lines.slice(0, -1) }, target),
  ).toEqual({ status: "unknown" });
});
it.each([
  ["A\n", "A"],
  ["A\n\n", "A\r\n"],
  ["wrapped", "wrapped"],
  ["", ""],
  ["A\r\nB\n", "A\r\nB"],
  ["界\n", "界"],
])("seeds both backings with stock control normalization %j", (capture, expected) => {
  const decoded = decodeNativeAtomicDualSnapshot(reply(records(Buffer.from(capture))), target);
  expect(decoded.status).toBe("ok");
  if (decoded.status !== "ok") return;
  const feed = new PaneFeed(),
    epoch = feed.beginReseed();
  feed.captureDualReply(epoch - 1, decoded.capture, decoded.ansiCapture);
  expect(feed.currentState()).toBe("awaiting-capture");
  feed.captureDualReply(epoch, decoded.capture, decoded.ansiCapture);
  feed.delta(Buffer.from("later"));
  const events = feed.cursorReply(epoch, cursor);
  expect(events.map((event) => event.type)).toEqual(["reset", "seed", "delta", "cursor"]);
  const seed = events.find((event) => event.type === "seed");
  expect(seed?.type === "seed" && seed.native).toEqual(decoded.capture);
  expect(seed?.type === "seed" && Buffer.from(seed.data).toString()).toBe(expected);
});
