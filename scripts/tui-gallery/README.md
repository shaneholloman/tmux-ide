# Production TUI gallery

Run `pnpm gallery:tui` from the checkout (dependencies installed, supported Bun available).
This development-only gallery imports the same Home roster, machine sidebar and Help/reference dialog, pane header and footer that the application renders. It has deterministic fixtures and simulated callbacks; it does not discover daemons, connect to hosts, launch agents or mutate tmux sessions.

The top line identifies the input mode. **F12** switches between gallery controls and component interaction. Gallery control keys are inactive during component interaction, so typing into search does not change the theme or quit the gallery.

| Controls mode                           | Action                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `1` / `2` / `3` / `4` / `5` / `6` / `7` | Home / Sidebar / Help / Pane header / Footer / Working sessions / Pane modes preview |
| `t`                                     | Toggle dark/light                                                                    |
| `v`                                     | Normal (112×30) / narrow (48×18) component viewport                                  |
| `s`                                     | Next fixture: mixed, busy, attention, offline, empty, long labels                    |
| `r`                                     | Reset current component state and last action                                        |
| `q`                                     | Quit                                                                                 |
| `F12`                                   | Enter/leave component interaction                                                    |

The viewport clamps to the available terminal space. The sidebar retains its production 36-column maximum width. Home also includes a completed pane-read receipt using the production interaction component. Fixtures affect Home and Sidebar; Help content is real production guidance and does not vary with fleet fixture state.

In interaction mode, use the component's ordinary keys or mouse. Home supports searching, filtering, moving and opening rows. Sidebar actions record simulated results on the last line. Help supports reference navigation, search and scrolling; Escape closes it. Press F12 then `r` to reopen it. No displayed action executes a live command. Ctrl-C exits through the renderer.

Run `pnpm test:tui-gallery` for renderer coverage. `fixtures.ts` exports reusable deterministic Home and sidebar data. `TuiGallery` accepts an optional `initial` configuration for headless captures (story index, light/narrow booleans, fixture-state index and interaction mode). Production startup must not import this directory.

Pane header states show working, attention, disconnected, no activity, and long titles. Click the title or menu to record a simulated action. Footer states show connection and notification messages, Home hints in the empty fixture, and contextual action buttons; F5/F6/F7/F10 simulate actions during interaction mode.

## Working sessions

Story **6** renders the same `WorkingSessions` and `SessionRow` components used in the live sidebar, with fixture session data and simulated callbacks. Both use the shared navigation primitive, semantic palette and status icons. Machine and tmux-server context distinguish similarly named sessions.

Press F12 to interact, then ↑/↓ (or j/k), Home/End and Enter to open a simulated session. Clicking a row does the same. A new-result marker clears only when that session is opened; moving selection does not acknowledge it. Needs-input remains until the underlying state changes. Offline sessions cannot open. F6 or the Browse button records a catalog action. Reset restores the fixture and unread markers.

Compact mode, reordering, navigation history and persistence remain future work. The gallery creates no background terminal streams. In the live sidebar, Tab moves keyboard focus between working sessions and the machine tree; closing a working tab removes navigation state, not the tmux session. New-result tracking acknowledges observed running-to-complete transitions on retained, inactive sessions. Unavailable, partial or nondefault-server agent coverage is shown as unknown rather than inferred.

In pane-header story **4**, press F12 to interact. **M** cycles live / scrollback / expanded view; **C** cycles connected / reconnecting / read-only. Click Back to live or Restore to reset the simulated view. The status label uses the same presentation policy as Home and the Agents sidebar; urgent activity remains visible alongside view-mode actions.

## Pane modes and agent interactions (design preview)

Story **7** is a proposed layout, not the production pane header. It uses the production `PaneInteraction` and `PaneModeControl` components, alongside shared theme, button and modal primitives. Production keeps these controls in the existing header row; this story previews an additional reserved interaction row. Press **F12**, then **M** to cycle live / scrollback / expanded / both and **I** to cycle named reads, sends, failures, unknown external input and expired feedback. **D** or Details opens the relationship and receipt phase. **Enter** invokes the visible mode action. The overflow menu offers Restore while scrollback is active in an expanded pane. Escape closes dialogs.

The interaction strip reserves one extra row, including when quiet, to avoid shifting terminal content when feedback expires. All actors and events are fixtures; this preview does not connect to tmux or send agent input. Gallery theme and narrow-size controls remain available after F12 returns to controls mode.

Story 7 now includes fixture playback: **P** plays/stops a read or send, **S** selects read/send, **F** selects slow (1.2 seconds) or fast (20 ms) completion, and **A** toggles motion/static. Slow pending operations use the production shared spinner; fast ones skip it. Verified source names appear on completion, whose check mark remains for 3.2 seconds before quiet. Details keep the inspected receipt stable. These timings are demonstration fixtures, not measured daemon latency. Theme reduced-motion preferences always take precedence; leaving the story destroys playback timers.
