/** Shared release baseline; compare components so 3.10 is newer than 3.7. */
export function requireSupportedTmuxVersion(value: string): void {
  const match = /^(?:tmux\s+)?(\d+)\.(\d+)[a-z]?(?:\s|$)/u.exec(value.trim());
  if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 7))) return;
  throw new Error(
    `tmux 3.7 or newer is required (found ${value.trim() || "unknown version"}). Upgrade tmux and explicitly migrate older sessions when ready; existing servers have not been replaced.`,
  );
}
