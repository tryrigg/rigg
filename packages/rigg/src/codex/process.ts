import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import readline from "node:readline"

import { filterEnv } from "../util/env"
import { formatCodexUpgradeMessage, isCodexVersionSupported, parseCodexVersion } from "./version"

const STDERR_BENIGN_PATTERNS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
] as const

export type CodexProcessOptions = {
  binaryPath?: string | undefined
  cwd: string
  env: Record<string, string | undefined>
}

export type CodexAppServerProcess = {
  child: ChildProcessWithoutNullStreams
  close: () => Promise<void>
  stderr: readline.Interface
  stdout: readline.Interface
  write: (message: unknown) => void
}

export function assertSupportedCodexVersion(options: CodexProcessOptions): void {
  const result = spawnSync(options.binaryPath ?? "codex", ["--version"], {
    cwd: options.cwd,
    encoding: "utf8",
    env: filterEnv(options.env),
    shell: process.platform === "win32",
  })

  if (result.error !== undefined) {
    throw result.error
  }

  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  const version = parseCodexVersion(combinedOutput)
  if (result.status !== 0) {
    throw new Error(`Failed to read Codex CLI version: ${combinedOutput.trim()}`)
  }
  if (version === null || !isCodexVersionSupported(version)) {
    throw new Error(formatCodexUpgradeMessage(version))
  }
}

export function startCodexAppServer(options: CodexProcessOptions): CodexAppServerProcess {
  const child = spawn(options.binaryPath ?? "codex", ["app-server"], {
    cwd: options.cwd,
    env: filterEnv(options.env),
    shell: process.platform === "win32",
    stdio: "pipe",
  })

  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    throw new Error("failed to start codex app-server with piped stdio")
  }

  const stdout = readline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
  const stderr = readline.createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY })

  return {
    child,
    close: async () => {
      stdout.close()
      stderr.close()
      child.stdin.end()
      if (child.exitCode !== null) {
        return
      }
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve())
        child.kill("SIGTERM")
        setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL")
          }
        }, 1_000)
      })
    },
    stderr,
    stdout,
    write: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
  }
}

export function isBenignCodexDiagnostic(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length === 0 || STDERR_BENIGN_PATTERNS.some((snippet) => trimmed.includes(snippet))
}
