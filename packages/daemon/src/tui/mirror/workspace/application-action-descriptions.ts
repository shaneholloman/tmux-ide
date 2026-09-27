/** Shared presentation/binding metadata. Context owners still decide availability and execution. */
export const HOME_ACTIONS = {
  search: { key: "/", keys: "/", label: "Search", description: "Find an agent or workspace" },
  machine: { key: "f", keys: "f", label: "Machines", description: "Cycle machine filter" },
  all: { key: "0", keys: "0", label: "All", description: "Show all agent activity", value: "all" },
  working: {
    key: "w",
    keys: "w",
    label: "Working",
    description: "Show working agents",
    value: "working",
  },
  attention: {
    key: "a",
    keys: "a",
    label: "Needs attention",
    description: "Toggle attention filter",
    value: "attention",
  },
  open: { key: "enter", keys: "Enter", label: "open", description: "Open selected agent" },
} as const;
export const HOME_ACTIVITY_ACTIONS = [
  HOME_ACTIONS.all,
  HOME_ACTIONS.working,
  HOME_ACTIONS.attention,
] as const;

export const CHROME_ACTIONS = {
  home: { keys: "F1", label: "Home" },
  terminals: { keys: "F2", label: "Terminals" },
  commands: { keys: "F5", label: "Commands" },
  sessions: { keys: "F6", label: "Sessions" },
  attention: { keys: "F7", label: "Attention" },
  tabs: { keys: "F9", label: "Tabs" },
  sidebar: { keys: "F10", label: "Show / hide sidebar" },
} as const;
export const SIDEBAR_ACTIONS = {
  help: { key: "?", keys: "?", label: "Help", description: "Using tmux-ide" },
  retry: {
    key: "r",
    keys: "R",
    label: "Retry connection",
    description: "Retry selected machine connection",
  },
  disconnect: {
    key: "d",
    keys: "D",
    label: "Disconnect",
    description: "Disconnect selected machine",
  },
  add: { key: "a", keys: "A", label: "Add machine", description: "Add an SSH machine" },
} as const;
