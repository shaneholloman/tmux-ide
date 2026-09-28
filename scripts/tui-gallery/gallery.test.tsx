/* @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { TuiGallery } from "./gallery.tsx";
import { galleryAgents, galleryMachines, GALLERY_STATES } from "./fixtures.ts";
import {
  renderForTest,
  expectFrameBounds,
} from "../../packages/daemon/src/tui/mirror/testing/renderer-harness.test.ts";

function key(setup: Awaited<ReturnType<typeof renderForTest>>, name: string) {
  setup.renderer.keyInput.emit("keypress", {
    name,
    sequence: name,
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    eventType: "press",
    repeated: false,
    preventDefault() {},
    stopPropagation() {},
  });
}
for (const light of [false, true])
  for (const narrow of [false, true])
    for (const story of [0, 1, 2]) {
      test(`production story ${story}, ${light ? "light" : "dark"}, ${narrow ? "narrow" : "normal"}`, async () => {
        const setup = await renderForTest(
          () => (
            <TuiGallery
              width={116}
              height={38}
              initial={{ story, light, narrow }}
              onQuit={() => {}}
            />
          ),
          { width: 116, height: 38 },
        );
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expectFrameBounds(frame, 116, 38);
        expect(frame).toContain(["quiet-otter", "Local (fixture)", "Using tmux-ide"][story]!);
        expect(frame).toContain("F12 toggle");
        expect(frame).not.toContain("�");
      });
    }
test("gallery controls never steal component search keys or dispatch real actions", async () => {
  const actions: string[] = [];
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={116}
        height={38}
        onAction={(value) => actions.push(value)}
        onQuit={() => actions.push("quit")}
      />
    ),
    { width: 116, height: 38 },
  );
  await setup.renderOnce();
  key(setup, "return");
  expect(actions).toEqual([]);
  key(setup, "f12");
  await setup.renderOnce();
  key(setup, "return");
  expect(actions).toEqual(["Open quiet-otter (keyboard; simulated)"]);
  await setup.mockInput.pressKey("/");
  await setup.mockInput.pressKey("t");
  await setup.mockInput.pressKey("q");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("dark");
  expect(actions).toHaveLength(1);
  key(setup, "f12");
  await setup.renderOnce();
  await setup.mockInput.pressKey("r");
  await setup.mockInput.pressKey("t");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("light");
  expect(setup.captureCharFrame()).toContain("quiet-otter");
});
test("reference close and reset remove old modal routes", async () => {
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={116}
        height={38}
        initial={{ story: 2, interacting: true }}
        onQuit={() => {}}
      />
    ),
    { width: 116, height: 38 },
  );
  await setup.renderOnce();
  key(setup, "escape");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Dialog closed");
  key(setup, "f12");
  await setup.renderOnce();
  await setup.mockInput.pressKey("r");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Using tmux-ide");
  await setup.mockInput.pressKey("1");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("quiet-otter");
  expect(setup.captureCharFrame()).toContain("Quick actions");
});
test("all fixture states are deterministic and offline rows cannot activate", () => {
  for (const state of GALLERY_STATES) {
    expect(galleryAgents(state)).toEqual(galleryAgents(state));
    expect(galleryMachines(state)).toEqual(galleryMachines(state));
  }
  expect(galleryAgents("empty").rows).toHaveLength(0);
  expect(galleryAgents("offline").rows.every((row) => row.disabled)).toBe(true);
});

test("small terminal clamps the gallery viewport and offline activation stays simulated", async () => {
  const actions: string[] = [];
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={40}
        height={24}
        initial={{ state: 3, interacting: true }}
        onAction={(value) => actions.push(value)}
        onQuit={() => {}}
      />
    ),
    { width: 40, height: 24 },
  );
  await setup.renderOnce();
  expectFrameBounds(setup.captureCharFrame(), 40, 24);
  key(setup, "return");
  expect(actions).toEqual([]);
});
for (const state of [1, 2, 3, 4, 5]) {
  test(`Home fixture ${GALLERY_STATES[state]} renders`, async () => {
    const setup = await renderForTest(
      () => <TuiGallery width={116} height={38} initial={{ state }} onQuit={() => {}} />,
      { width: 116, height: 38 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain(GALLERY_STATES[state]!);
    expectFrameBounds(setup.captureCharFrame(), 116, 38);
  });
}
test("sidebar agents belong to a displayed session for every fixture", () => {
  for (const state of GALLERY_STATES)
    for (const machine of galleryMachines(state)) {
      for (const agent of machine.agents ?? [])
        expect(machine.sessions.some((session) => session.name === agent.sessionName)).toBe(true);
    }
});

test("short Home viewport keeps End selection visible before opening", async () => {
  const actions: string[] = [];
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={80}
        height={12}
        initial={{ interacting: true }}
        onAction={(value) => actions.push(value)}
        onQuit={() => {}}
      />
    ),
    { width: 80, height: 12 },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("quiet-otter");
  expect(setup.captureCharFrame()).not.toContain("release-review");
  key(setup, "end");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("release-review");
  expect(setup.captureCharFrame()).not.toContain("quiet-otter");
  key(setup, "return");
  expect(actions).toEqual(["Open release-review (keyboard; simulated)"]);
});

test("Home attention key toggles the same filter as its button", async () => {
  const setup = await renderForTest(
    () => <TuiGallery width={116} height={38} initial={{ interacting: true }} onQuit={() => {}} />,
    { width: 116, height: 38 },
  );
  await setup.renderOnce();
  await setup.mockInput.pressKey("a");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("quiet-otter");
  expect(setup.captureCharFrame()).not.toContain("bright-panda");
  await setup.mockInput.pressKey("a");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("bright-panda");
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("Needs attention"));
  const x = lines[y]!.indexOf("Needs attention");
  await setup.mockMouse.click(x + 2, y, 0);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).not.toContain("bright-panda");
  expect(setup.captureCharFrame()).toContain("quiet-otter");
});

for (const story of [3, 4])
  for (const light of [false, true])
    for (const narrow of [false, true])
      for (const state of [0, 1, 2, 3, 4, 5]) {
        test(`chrome story ${story} ${light ? "light" : "dark"} ${narrow ? "narrow" : "normal"} ${GALLERY_STATES[state]}`, async () => {
          const setup = await renderForTest(
            () => (
              <TuiGallery
                width={116}
                height={38}
                initial={{ story, light, narrow, state }}
                onQuit={() => {}}
              />
            ),
            { width: 116, height: 38 },
          );
          await setup.renderOnce();
          const frame = setup.captureCharFrame();
          expectFrameBounds(frame, 116, 38);
          expect(frame).toContain(story === 3 ? "⋯" : "Commands");
          expect(frame).not.toContain("�");
        });
      }
test("footer actions remain simulated and controls mode owns story selection", async () => {
  const actions: string[] = [];
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={116}
        height={38}
        initial={{ story: 4 }}
        onAction={(value) => actions.push(value)}
        onQuit={() => {}}
      />
    ),
    { width: 116, height: 38 },
  );
  await setup.renderOnce();
  key(setup, "f6");
  expect(actions).toEqual([]);
  key(setup, "f12");
  key(setup, "f6");
  expect(actions).toEqual(["Sessions (simulated)"]);
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("F6 Sessions"));
  const x = lines[y]!.indexOf("Sessions");
  await setup.mockMouse.click(x + 2, y, 0);
  expect(actions).toEqual(["Sessions (simulated)", "Sessions (simulated)"]);
});

for (const light of [false, true]) {
  for (const state of [0, 3, 4, 5]) {
    test(`working sessions prototype: light=${light}, state=${state}`, async () => {
      const setup = await renderForTest(
        () => (
          <TuiGallery
            width={60}
            height={26}
            initial={{ story: 5, light, narrow: true, state }}
            onQuit={() => {}}
          />
        ),
        { width: 60, height: 26 },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expectFrameBounds(frame, 60, 26);
      expect(frame).toContain("Working sessions");
      expect(frame).toContain("Browse all sessions");
      expect(frame).not.toContain("�");
      if (state === 0) {
        expect(frame).toContain("new result");
        expect(frame).toContain("needs input");
        expect(frame).toContain("Spark · development");
      }
      if (state === 3) expect(frame).toContain("offline");
      if (state === 4) expect(frame).toContain("No working sessions yet");
    });
  }
}
test("working session results clear only on open; attention survives opening", async () => {
  const actions: string[] = [];
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={60}
        height={26}
        initial={{ story: 5 }}
        onQuit={() => {}}
        onAction={(value) => actions.push(value)}
      />
    ),
    { width: 60, height: 26 },
  );
  await setup.renderOnce();
  key(setup, "return");
  expect(actions).toEqual([]);
  key(setup, "f12");
  key(setup, "down");
  key(setup, "down");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("new result");
  key(setup, "return");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).not.toContain("new result");
  expect(actions).toEqual(["Open documentation · Spark · default (simulated)"]);
  key(setup, "up");
  key(setup, "return");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("needs input");
  key(setup, "f6");
  expect(actions.at(-1)).toBe("Browse all sessions (simulated)");
});
test("short working-session viewport keeps End target visible and offline cannot open", async () => {
  const actions: string[] = [];
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={60}
        height={14}
        initial={{ story: 5, interacting: true, state: 3 }}
        onQuit={() => {}}
        onAction={(value) => actions.push(value)}
      />
    ),
    { width: 60, height: 14 },
  );
  key(setup, "end");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Spark · development");
  key(setup, "return");
  expect(actions).toEqual([]);
});
test("working-session pointer opens once and acknowledges the same result as Enter", async () => {
  const actions: string[] = [];
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={60}
        height={26}
        initial={{ story: 5, interacting: true }}
        onQuit={() => {}}
        onAction={(value) => actions.push(value)}
      />
    ),
    { width: 60, height: 26 },
  );
  await setup.renderOnce();
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("documentation"));
  expect(y).toBeGreaterThan(0);
  await setup.mockMouse.click(5, y, 0);
  await setup.renderOnce();
  expect(actions).toEqual(["Open documentation · Spark · default (simulated)"]);
  expect(setup.captureCharFrame()).not.toContain("new result");
});

test("pane status gallery exercises view mode and connection priority through production chrome", async () => {
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={116}
        height={38}
        initial={{ story: 3, interacting: true }}
        onQuit={() => {}}
      />
    ),
    { width: 116, height: 38 },
  );
  key(setup, "m");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Scrollback");
  key(setup, "c");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Reconnecting…");
  expect(setup.captureCharFrame()).toContain("Back to live");
  key(setup, "c");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Read-only");
});

for (const light of [false, true])
  for (const narrow of [false, true]) {
    test(`pane mode concept retains identity, actions and interaction context (${light}, ${narrow})`, async () => {
      const setup = await renderForTest(
        () => (
          <TuiGallery
            width={116}
            height={38}
            initial={{ story: 6, interacting: true, light, narrow }}
            onQuit={() => {}}
          />
        ),
        { width: 116, height: 38 },
      );
      await setup.renderOnce();
      expectFrameBounds(setup.captureCharFrame(), 116, 38);
      expect(setup.captureCharFrame()).toContain("Claude");
      expect(setup.captureCharFrame()).toContain("Back to live");
      expect(setup.captureCharFrame()).toContain("Read requested");
      const outputRow = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("$ pnpm test"));
      key(setup, "i");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Read by Codex");
      key(setup, "d");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Read completed");
      key(setup, "escape");
      key(setup, "return");
      await setup.renderOnce();
      expect(setup.captureCharFrame().split("\n")[5]).not.toContain("Back to live");
      expect(setup.captureCharFrame()).toContain("Read by Codex");
      key(setup, "m");
      key(setup, "m");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Expanded");
      expect(setup.captureCharFrame()).toContain("Restore");
      for (let i = 0; i < 5; i++) key(setup, "i");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Read by Codex");
      expect(
        setup
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes("$ pnpm test")),
      ).toBe(outputRow);
    });
  }

test("playback cancels superseded receipts and keeps completion visible before quiet", async () => {
  const { createInteractionPlayback } = await import("./pane-interaction-playback.ts");
  const scheduled: { run: () => void; delay: number; cancelled: boolean }[] = [];
  const events: [number, boolean][] = [];
  const playback = createInteractionPlayback(
    (event, playing) => events.push([event, playing]),
    (run, delay) => {
      const item = { run, delay, cancelled: false };
      scheduled.push(item);
      return () => {
        item.cancelled = true;
      };
    },
  );
  playback.play("read", false);
  expect(events).toEqual([[0, true]]);
  expect(scheduled.map((item) => item.delay)).toEqual([1200, 4400]);
  scheduled[0]!.run();
  expect(events.at(-1)).toEqual([1, true]);
  playback.play("send", true);
  expect(scheduled.slice(0, 2).every((item) => item.cancelled)).toBe(true);
  scheduled[1]!.run();
  expect(events.at(-1)).toEqual([2, true]);
  expect(scheduled[2]!.delay).toBe(20);
  scheduled[2]!.run();
  expect(events.at(-1)).toEqual([3, true]);
  scheduled[3]!.run();
  expect(events.at(-1)).toEqual([6, false]);
  playback.stop();
  expect(scheduled.every((item) => item.cancelled)).toBe(true);
});

test("static playback preserves geometry and authenticates actor only at completion", async () => {
  const setup = await renderForTest(
    () => (
      <TuiGallery
        width={116}
        height={38}
        initial={{ story: 6, interacting: true }}
        onQuit={() => {}}
      />
    ),
    { width: 116, height: 38 },
  );
  key(setup, "a");
  key(setup, "p");
  await setup.renderOnce();
  const pending = setup.captureCharFrame();
  expect(pending).toContain("Read requested");
  expect(pending).not.toContain("Read by Codex");
  await Bun.sleep(100);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toBe(pending);
  key(setup, "p");
  key(setup, "f");
  key(setup, "p");
  await Bun.sleep(60);
  await setup.renderOnce();
  const completed = setup.captureCharFrame();
  expect(completed).toContain("Read by Codex");
  expect(completed.split("\n").findIndex((line) => line.includes("$ pnpm test"))).toBe(
    pending.split("\n").findIndex((line) => line.includes("$ pnpm test")),
  );
  key(setup, "d");
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Read completed");
  setup.renderer.destroy();
});
