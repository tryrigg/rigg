import { filterEnv } from "../util/env"
import { normalizeError } from "../util/error"
import { readLines, type LineSource } from "../util/line"
import { createPromiseKit } from "../util/promise"
import { spawnSpec } from "../util/spawn"

export type ProcOptions = {
  cwd: string
  env: Record<string, string | undefined>
}

export type ProcExit = {
  code: number | null
  error?: Error | undefined
  expected: boolean
  signal: NodeJS.Signals | null
}

export type JsonRpcServerProcess = {
  close: () => Promise<void>
  exited: Promise<ProcExit>
  stderr: LineSource
  stdout: LineSource
  write: (message: unknown) => void
}

export function runSyncCommand(
  command: string,
  args: string[],
  options: ProcOptions,
): {
  status: number
  stderr: string
  stdout: string
} {
  const env = filterEnv(options.env)
  const spec = spawnSpec(command, args, { cwd: options.cwd, env })
  const result = Bun.spawnSync({
    ...spec,
    cwd: options.cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  })

  return {
    status: result.exitCode,
    stderr: result.stderr === undefined ? "" : result.stderr.toString("utf8"),
    stdout: result.stdout === undefined ? "" : result.stdout.toString("utf8"),
  }
}

export function startJsonRpcServer(command: string, args: string[], options: ProcOptions): JsonRpcServerProcess {
  const env = filterEnv(options.env)
  const spec = spawnSpec(command, args, {
    cwd: options.cwd,
    env,
  })
  let closePromise: Promise<void> | undefined
  let closing = false
  const stdoutReady = createPromiseKit<LineSource>()
  const stderrReady = createPromiseKit<LineSource>()
  const exit = createPromiseKit<ProcExit>()
  const exited = exit.promise

  const child = Bun.spawn({
    ...spec,
    cwd: options.cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    onExit: (proc, code) => {
      void Promise.all([stdoutReady.promise, stderrReady.promise])
        .then(([stdout, stderr]) => Promise.all([stdout.done, stderr.done]))
        .then(([stdoutError, stderrError]) => {
          exit.resolve({
            code,
            error: stdoutError ?? stderrError,
            expected: closing,
            signal: proc.signalCode,
          })
        })
        .catch((error) => {
          exit.resolve({
            code,
            error: normalizeError(error),
            expected: closing,
            signal: proc.signalCode,
          })
        })
    },
  })

  const stdout = readLines(child.stdout)
  const stderr = readLines(child.stderr)
  stdoutReady.resolve(stdout)
  stderrReady.resolve(stderr)

  return {
    close: async () => {
      if (closePromise !== undefined) {
        await closePromise
        return
      }

      closing = true
      closePromise = (async () => {
        if (child.exitCode === null) {
          await child.stdin.end()
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
