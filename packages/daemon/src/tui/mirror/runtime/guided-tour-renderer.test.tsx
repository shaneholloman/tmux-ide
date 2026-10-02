/* @jsxImportSource @opentui/solid */
import { useRenderer } from "@opentui/solid";
import { createSignal, onCleanup, Show } from "solid-js";
import { createGuidedTourLoader } from "./application-guided-tour-loader.ts";
import { GuidedTourCoachMount } from "./application-guided-tour-lazy.tsx";
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";
import { GuidedTourCoach } from "./guided-tour-coach.tsx";
import { initialGuidedTourState } from "./guided-tour.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  destroyTestRenderer,
  expectFrameBounds,
  renderForTest,
} from "../testing/renderer-harness.test.ts";
describe("guided tour coach", () => {
  it("keeps keyboard input unclaimed and activates only clicked coach controls", async () => {
    const calls: string[] = [];
    const setup = await renderForTest(
      () => (
        <GuidedTourCoach
          state={{ ...initialGuidedTourState(), active: true }}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          width={68}
          height={10}
          onPause={() => calls.push("pause")}
          onWelcomeRead={() => calls.push("welcome")}
          onCreatePractice={() => {}}
          onOpenCommands={() => {}}
          onOpenAppearance={() => {}}
          onOpenHome={() => {}}
          onOpenPractice={() => {}}
        />
      ),
      { width: 80, height: 24 },
    );
    await setup.renderOnce();
    await setup.mockInput.pressEnter();
    expect(calls).toEqual([]);
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Pause tour"));
    await setup.mockMouse.click(lines[y]!.indexOf("Pause tour"), y, MouseButtons.LEFT);
    expect(calls).toEqual(["pause"]);
  });
  for (const mode of ["dark", "light"] as const) {
    for (const [width, height] of [
      [80, 24],
      [28, 10],
      [8, 6],
    ]) {
      it(`fits ${width}x${height} ${mode} with a visible pause action`, async () => {
        const setup = await renderForTest(
          () => (
            <GuidedTourCoach
              state={{ ...initialGuidedTourState(), active: true }}
              theme={createSemanticThemeSnapshot({ mode })}
              width={width!}
              height={height!}
              onPause={() => {}}
              onWelcomeRead={() => {}}
              onCreatePractice={() => {}}
              onOpenCommands={() => {}}
              onOpenAppearance={() => {}}
              onOpenHome={() => {}}
              onOpenPractice={() => {}}
            />
          ),
          { width: width!, height: height! },
        );
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expectFrameBounds(frame, width!, height!);
        expect(frame).toContain(width! >= 28 ? "Pause tour" : "Pa…");
      });
    }
  }
});

describe("deferred guided tour coach", () => {
  it("mounts in the renderer context after import and preserves nonmodal mouse interaction", async () => {
    let resolve!: (module: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const controller = new AbortController();
    let loader!: ReturnType<
      typeof createGuidedTourLoader<
        string,
        { open(): void; Coach(): ReturnType<typeof GuidedTourCoach> }
      >
    >;
    let inheritedRenderer: ReturnType<typeof useRenderer> | undefined;
    let cleanup = 0;
    let pauses = 0;
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const setup = await renderForTest(
      () => {
        loader = createGuidedTourLoader({
          load: () => pending,
          identity: () => 1,
          signal: controller.signal,
          create: () => {
            inheritedRenderer = useRenderer();
            onCleanup(() => {
              cleanup++;
            });
            const [active, setActive] = createSignal(false);
            return {
              open: () => setActive(true),
              Coach: () => (
                <Show when={active()}>
                  <GuidedTourCoach
                    state={{ ...initialGuidedTourState(), active: true }}
                    theme={theme}
                    width={68}
                    height={10}
                    onPause={() => {
                      pauses++;
                      setActive(false);
                    }}
                    onWelcomeRead={() => {}}
                    onCreatePractice={() => {}}
                    onOpenCommands={() => {}}
                    onOpenAppearance={() => {}}
                    onOpenHome={() => {}}
                    onOpenPractice={() => {}}
                  />
                </Show>
              ),
            };
          },
        });
        return <GuidedTourCoachMount integration={loader.integration} />;
      },
      { width: 80, height: 24 },
    );
    try {
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Learn tmux-ide");
      const opening = loader.open();
      resolve("module");
      await opening;
      expect(inheritedRenderer).toBe(setup.renderer);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Learn tmux-ide");
      await setup.mockInput.pressEnter();
      expect(pauses).toBe(0);
      const lines = setup.captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes("Pause tour"));
      expect(y).toBeGreaterThanOrEqual(0);
      await setup.mockMouse.click(lines[y]!.indexOf("Pause tour"), y, MouseButtons.LEFT);
      await setup.renderOnce();
      expect(pauses).toBe(1);
      expect(setup.captureCharFrame()).not.toContain("Learn tmux-ide");
    } finally {
      destroyTestRenderer(setup);
    }
    expect(cleanup).toBe(1);
  });
});
