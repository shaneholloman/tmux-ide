import { beforeEach, describe, expect, it, vi } from "vitest";
const delivery = vi.hoisted(() => vi.fn());
vi.mock("../send.ts", () => ({ deliverMessage: delivery }));
vi.mock("../agent-explain.ts", () => ({ buildReport: vi.fn() }));
vi.mock("../tui/team/report.ts", () => ({ toFleetJson: vi.fn() }));
vi.mock("../tui/team/projects.ts", () => ({ listTeamProjects: vi.fn() }));
vi.mock("../tui/team/sessions.ts", () => ({ listTeamSessions: vi.fn() }));
vi.mock("../tui/team/wait.ts", () => ({
  waitForAgentStatus: vi.fn(),
  waitForOutputMatch: vi.fn(),
}));
vi.mock("./lifecycle.ts", () => ({
  resolveLaunchCommand: vi.fn(),
  restartAgent: vi.fn(),
  spawnAgent: vi.fn(),
  stopAgent: vi.fn(),
}));
import { createVerbHandlers } from "./verbs.ts";
import { dispatchLine } from "./dispatch.ts";
import { createStatusTracker } from "../tui/detect/classify.ts";

beforeEach(() => {
  delivery.mockReset();
});
const dispatch = (params: unknown) =>
  dispatchLine(
    JSON.stringify({ v: 1, id: "send-1", verb: "send", params }),
    createVerbHandlers({ tracker: createStatusTracker() }),
    { subscribe: () => {} },
  );
describe("control send compatibility", () => {
  it("forwards explicit session, target, no-enter and dispatch directory", async () => {
    const params = {
      session: "work",
      target: "%2",
      message: "first\nsecond",
      noEnter: true,
      dir: "/project",
    };
    delivery.mockReturnValue({ ok: true, sentViaFile: false });
    expect(await dispatch(params)).toEqual({
      v: 1,
      id: "send-1",
      ok: true,
      data: { ok: true, sentViaFile: false },
    });
    expect(delivery).toHaveBeenCalledExactlyOnceWith(params);
  });
  it("rejects malformed messages before delivery", async () => {
    expect(await dispatch({ session: "work", target: "%2", message: 42 })).toMatchObject({
      ok: false,
      error: { code: "bad-request" },
    });
    expect(delivery).not.toHaveBeenCalled();
  });
  it("does not retry when delivery throws after an uncertain write", async () => {
    delivery.mockImplementation(() => {
      throw new Error("connection reset after write");
    });
    expect(await dispatch({ session: "work", target: "%2", message: "hello" })).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(delivery).toHaveBeenCalledTimes(1);
  });
});
