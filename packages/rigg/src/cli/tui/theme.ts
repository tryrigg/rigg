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
  codex: "blue",
  write_file: "magenta",
  group: "dim",
  loop: "cyan",
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
