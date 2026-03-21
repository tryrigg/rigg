import { spawn, spawnSync } from "node:child_process"
import readline from "node:readline"

import { filterEnv } from "../util/env"

export type CursorProcessOptions = {
  binaryPath?: string | undefined
  cwd: string
  env: Record<string, string | undefined>
  model?: string | undefined
}

export type CursorAcpProcess = {
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

export function assertVersion(options: CursorProcessOptions): void {
  const result = spawnSync(options.binaryPath ?? "cursor", ["--version"], {
    cwd: options.cwd,
    encoding: "utf8",
    env: filterEnv(options.env),
    shell: process.platform === "win32",
  })

  if (result.error !== undefined) {
    throw result.error
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
    throw new Error(`Failed to read Cursor CLI version: ${output}`)
  }
}

export function startServer(options: CursorProcessOptions): CursorAcpProcess {
  const args = ["agent"]
  if (options.model !== undefined) {
    args.push("--model", options.model)
  }
  args.push("acp")
  const child = spawn(options.binaryPath ?? "cursor", args, {
    cwd: options.cwd,
    env: filterEnv(options.env),
    shell: process.platform === "win32",
    stdio: "pipe",
  })

  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    throw new Error("failed to start cursor agent acp with piped stdio")
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
