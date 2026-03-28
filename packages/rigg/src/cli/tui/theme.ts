export const colors = {
  brand: "cyan",
  success: "green",
  error: "red",
  warning: "yellow",
  info: "magenta",
  muted: "dim",
  file: "blue",
} as const

export const kindColors: Record<string, string> = {
  shell: "yellow",
  claude: "magenta",
  codex: "blue",
  cursor: "cyan",
  opencode: "white",
  write_file: "magenta",
  group: "dim",
  loop: "cyan",
  workflow: "cyan",
  parallel: "dim",
  branch: "dim",
  branch_case: "dim",
}

export const chars = {
  rule: "─",
  bullet: "▸",
  nextArrow: "→",
  promptCaret: "❯",
  outputBorderLive: "┊",
  outputBorderDone: "│",
  progressFilled: "█",
  progressEmpty: "░",
} as const
