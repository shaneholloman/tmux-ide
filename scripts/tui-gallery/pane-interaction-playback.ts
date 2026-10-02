/** Deterministic fixture playback, not daemon timing or an operation owner. */
export function createInteractionPlayback(
  publish: (event: number, playing: boolean) => void,
  schedule: (callback: () => void, delay: number) => () => void = (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
) {
  let cancel: (() => void)[] = [];
  let epoch = 0;
  const stop = () => {
    epoch++;
    cancel.forEach((fn) => fn());
    cancel = [];
  };
  return {
    stop,
    play(kind: "read" | "send", fast: boolean) {
      stop();
      const generation = epoch;
      const accepted = kind === "read" ? 0 : 2;
      const completed = accepted + 1;
      publish(accepted, true);
      const after = (delay: number, event: number, playing: boolean) => {
        cancel.push(
          schedule(() => {
            if (generation === epoch) publish(event, playing);
          }, delay),
        );
      };
      const duration = fast ? 20 : 1200;
      after(duration, completed, true);
      after(duration + 3200, 6, false);
    },
  };
}
