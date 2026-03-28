import { normalizeError } from "../../util/error"
import { compareVersions, parseVersion } from "../version"
import { runSyncCommand, startJsonRpcServer, type JsonRpcServerProcess, type ProcOptions } from "../proc"

const STDERR_BENIGN_PATTERNS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
] as const
const MIN_VERSION = "0.114.0"

export type CodexProcessOptions = ProcOptions & {
  binaryPath?: string | undefined
}

export type CodexAppServerProcess = JsonRpcServerProcess

export function assertVersion(options: CodexProcessOptions): void {
  const result = runVersion(options.binaryPath ?? "codex", options)
  const combinedOutput = `${result.stdout}\n${result.stderr}`
  const version = parseVersion(combinedOutput)
  if (result.status !== 0) {
    throw new Error(`Failed to read Codex CLI version: ${combinedOutput.trim()}`)
  }
  if (version === null || compareVersions(version, MIN_VERSION) < 0) {
    const current = version === null ? "the installed version" : `v${version}`
    throw new Error(`Codex CLI ${current} is too old for Rigg. Upgrade to v${MIN_VERSION} or newer.`)
  }
}

function runVersion(
  command: string,
  options: CodexProcessOptions,
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

export function startServer(options: CodexProcessOptions): CodexAppServerProcess {
  return startJsonRpcServer(options.binaryPath ?? "codex", ["app-server"], options)
}

export function isBenignCodexDiagnostic(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length === 0 || STDERR_BENIGN_PATTERNS.some((snippet) => trimmed.includes(snippet))
}
