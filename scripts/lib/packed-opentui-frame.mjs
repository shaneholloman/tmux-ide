/**
 * The responsive shell spells terminal focus as either `focus terminal` or the
 * compact `Terminals · terminal · …`, the component status bar's
 * `Terminals / terminal`, or the session-scoped component footer
 * `<session> Terminals Live tmux session discovered`, or the narrow Linux
 * combination of the active `●❯` tab marker and a live-session footer. All are
 * canonical focus projections. The current shortcut tabs also require a window
 * strip and the terminal-owned footer; a Home header alone is insufficient.
 * Platform glyph widths can choose different
 * variants at the same tmux size.
 */
export function frameShowsTerminalFocus(frame) {
  const lines = frame.trimEnd().split("\n");
  const contextualChrome =
    (/●❯/u.test(lines[0] ?? "") ||
      (/\bF1\b.*\bF2\b/u.test(lines[0] ?? "") && /\+ New window/u.test(lines[1] ?? ""))) &&
    /F6 Sessions/u.test(lines.at(-1) ?? "") &&
    /F5(?: Commands)?/u.test(lines.at(-1) ?? "") &&
    !/reconnect|disconnect|recover|read.only|unavailable/iu.test(lines[0] ?? "");
  return (
    contextualChrome ||
    frame.includes("focus terminal") ||
    /Terminals\s+·\s+terminal\s+·/u.test(frame) ||
    /Terminals\s*\/\s*terminal\b/u.test(frame) ||
    /\S+\s+Terminals\s+Live tmux session discovered\b/u.test(frame) ||
    (/●❯/u.test(frame) && /\S+\s+Live tmux session discovered\b/u.test(frame))
  );
}

/** The selected Home row's footer keeps its full location when its column truncates. */
export function frameShowsSelectedHomeAgent(
  frame,
  agentLabel,
  sessionName,
  expectedStatus = "working",
) {
  const lines = frame.split("\n");
  const summary = lines.findIndex((line) => line.includes("1 observed agent"));
  if (summary < 0) return false;
  const rows = lines.slice(summary + 1);
  const sharedRow = rows.some((line, index) => {
    const label = line.trim();
    const stateMatches =
      expectedStatus.toLowerCase() === "idle"
        ? label === agentLabel
        : expectedStatus.toLowerCase() === "working" &&
          /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●] /u.test(label) &&
          label.slice(2) === agentLabel;
    return stateMatches && rows[index + 1]?.trim() === `Local · Default · ${sessionName}`;
  });
  return (
    (sharedRow ||
      rows.some(
        (line, index) =>
          (line.includes(`› ${agentLabel} `) || line.trimStart().startsWith(`${agentLabel} `)) &&
          (line.includes("Local / Default /") ||
            rows[index + 1]?.trimEnd().endsWith("Local / Default") ||
            rows[index + 1]?.trimStart().startsWith(`${sessionName} · Local · Default · `)) &&
          line.trimEnd().split(/\s+/u).at(-1)?.toLowerCase() === expectedStatus.toLowerCase(),
      )) &&
    rows.some((line) => line.trim() === `Local / Default / ${sessionName} · Enter open`)
  );
}
