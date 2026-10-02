/** Content height of one pane in a qualified visible or saved tmux layout. */
export function layoutContentRows(
  paneTop: number,
  paneHeight: number,
  windowRows: number,
  border: "off" | "top" | "bottom",
): number {
  if (border === "off") return paneHeight;
  // Only the pane touching the configured outer edge loses a content row.
  // Interior separators are already represented by the layout geometry.
  const touchesStatusEdge = border === "top" ? paneTop === 0 : paneTop + paneHeight === windowRows;
  return paneHeight - (touchesStatusEdge ? 1 : 0);
}
