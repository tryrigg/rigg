import { spawn, spawnSync } from "node:child_process"
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
  close: () => Promise<void>
  exited: Promise<{
    code: number | null
    expected: boolean
    signal: NodeJS.Signals | null
  }>
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
  let closePromise: Promise<void> | undefined
  let closing = false

  const exited = new Promise<{
    code: number | null
    expected: boolean
    signal: NodeJS.Signals | null
  }>((resolve) => {
    child.once("exit", (code, signal) => {
      stdout.close()
      stderr.close()
      resolve({ code, expected: closing, signal })
    })
  })

  return {
    close: async () => {
      if (closePromise !== undefined) {
        await closePromise
        return
      }

      closing = true
      closePromise = (async () => {
        if (!child.stdin.destroyed && !child.stdin.writableEnded) {
          child.stdin.end()
        }

        if (child.exitCode !== null) {
          await exited
          return
        }

        child.kill("SIGTERM")
        const forceKillTimer = setTimeout(() => {
          if (child.exitCode === null) {
            child.kill("SIGKILL")
          }
        }, 1_000)
        forceKillTimer.unref()

        try {
          await exited
        } finally {
          clearTimeout(forceKillTimer)
        }
      })()

      await closePromise
    },
    exited,
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
