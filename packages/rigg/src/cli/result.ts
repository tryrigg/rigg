export type CommandResult = {
  exitCode: number
  stderrLines: string[]
  stdoutLines: string[]
}

export const PROJECT_NOT_FOUND_MESSAGE = "Could not find a .rigg directory from the current working directory."

export function success(stdoutLines: string[] = [], stderrLines: string[] = []): CommandResult {
  return { exitCode: 0, stderrLines, stdoutLines }
}

export function failure(stderrLines: string[] = [], exitCode = 1, stdoutLines: string[] = []): CommandResult {
  return { exitCode, stderrLines, stdoutLines }
}
