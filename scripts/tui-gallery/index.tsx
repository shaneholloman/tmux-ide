/* @jsxImportSource @opentui/solid */
import { createCliRenderer } from "@opentui/core";
import { render, useTerminalDimensions } from "@opentui/solid";
import { TuiGallery } from "./gallery.tsx";
const renderer = await createCliRenderer({ exitOnCtrlC: true });
await render(() => {
  const size = useTerminalDimensions();
  return (
    <TuiGallery width={size().width} height={size().height} onQuit={() => renderer.destroy()} />
  );
}, renderer);
