# Production TUI gallery

Run `pnpm gallery:tui` from the checkout (dependencies installed, supported Bun available).
This development-only gallery imports the same Home roster, machine sidebar and Help/reference dialog, pane header and footer that the application renders. It has deterministic fixtures and simulated callbacks; it does not discover daemons, connect to hosts, launch agents or mutate tmux sessions.

The top line identifies the input mode. **F12** switches between gallery controls and component interaction. Gallery control keys are inactive during component interaction, so typing into search does not change the theme or quit the gallery.

| Controls mode                     | Action                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `1` / `2` / `3` / `4` / `5` / `6` | Home / Sidebar / Help / Pane header / Footer / Working sessions prototype |
| `t`                               | Toggle dark/light                                                         |
| `v`                               | Normal (112×30) / narrow (48×18) component viewport                       |
| `s`                               | Next fixture: mixed, busy, attention, offline, empty, long labels         |
| `r`                               | Reset current component state and last action                             |
| `q`                               | Quit                                                                      |
| `F12`                             | Enter/leave component interaction                                         |

The viewport clamps to the available terminal space. The sidebar retains its production 36-column maximum width. Fixtures affect Home and Sidebar; Help content is real production guidance and does not vary with fleet fixture state.

In interaction mode, use the component's ordinary keys or mouse. Home supports searching, filtering, moving and opening rows. Sidebar actions record simulated results on the last line. Help supports reference navigation, search and scrolling; Escape closes it. Press F12 then `r` to reopen it. No displayed action executes a live command. Ctrl-C exits through the renderer.

Run `pnpm test:tui-gallery` for renderer coverage. `fixtures.ts` exports reusable deterministic Home and sidebar data. `TuiGallery` accepts an optional `initial` configuration for headless captures (story index, light/narrow booleans, fixture-state index and interaction mode). Production startup must not import this directory.

Pane header states show working, attention, disconnected, no activity, and long titles. Click the title or menu to record a simulated action. Footer states show connection and notification messages, Home hints in the empty fixture, and contextual action buttons; F5/F6/F7/F10 simulate actions during interaction mode.

## Working sessions prototype

Story **6** previews a proposed working-set sidebar; it is not part of the live application. It reuses semantic theme colors and the production shortcut button, with fixture session rows. Machine and tmux-server context distinguish similarly named sessions.

Press F12 to interact, then ↑/↓ (or j/k), Home/End and Enter to open a simulated session. Clicking a row does the same. A new-result marker clears only when that session is opened; moving selection does not acknowledge it. Needs-input remains until the underlying state changes. Offline sessions cannot open. F6 or the Browse button records a catalog action. Reset restores the fixture and unread markers.

Compact mode, reordering, navigation history and persistence remain future work. The prototype creates no background terminal streams and does not replace the live machine sidebar.
