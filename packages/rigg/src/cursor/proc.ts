import { normalizeError } from "../util/error"
import { runSyncCommand, startJsonRpcServer, type JsonRpcServerProcess, type ProcOptions } from "../util/proc"

export type CursorProcessOptions = ProcOptions & {
  binaryPath?: string | undefined
  model?: string | undefined
}

export type CursorAcpProcess = JsonRpcServerProcess

export function assertVersion(options: CursorProcessOptions): void {
  const result = runVersion(options.binaryPath ?? "cursor", options)
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim()
    throw new Error(`Failed to read Cursor CLI version: ${output}`)
  }
}

function runVersion(
  command: string,
  options: CursorProcessOptions,
): {
  status: number
  stderr: string
  stdout: string
} {
  try {
    return runSyncCommand(command, ["--version"], options)
  } catch (error) {
    throw new Error(`failed to run ${command} --version`, {
      cause: normalizeError(error),
    })
  }
}

export function startServer(options: CursorProcessOptions): CursorAcpProcess {
  const args = ["agent"]
  if (options.model !== undefined) {
    args.push("--model", options.model)
  }
  args.push("acp")
  return startJsonRpcServer(options.binaryPath ?? "cursor", args, options)
}
