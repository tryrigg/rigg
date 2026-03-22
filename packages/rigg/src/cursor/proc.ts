import { filterEnv } from "../util/env"
import { readLines, type LineSource } from "../util/line"
import { normalizeError } from "../util/error"
import { createPromiseKit } from "../util/promise"
import { spawnSpec } from "../util/spawn"

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
    error?: Error | undefined
    expected: boolean
    signal: NodeJS.Signals | null
  }>
  stderr: LineSource
  stdout: LineSource
  write: (message: unknown) => void
}

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
  const env = filterEnv(options.env)
  const spec = spawnSpec(command, ["--version"], { cwd: options.cwd, env })
  let result: ReturnType<typeof Bun.spawnSync>

  try {
    result = Bun.spawnSync({
      ...spec,
      cwd: options.cwd,
      env,
      stderr: "pipe",
      stdout: "pipe",
    })
  } catch (error) {
    throw new Error(`failed to run ${command} --version`, {
      cause: normalizeError(error),
    })
  }

  return {
    status: result.exitCode,
    stderr: result.stderr === undefined ? "" : result.stderr.toString("utf8"),
    stdout: result.stdout === undefined ? "" : result.stdout.toString("utf8"),
  }
}

export function startServer(options: CursorProcessOptions): CursorAcpProcess {
  const args = ["agent"]
  if (options.model !== undefined) {
    args.push("--model", options.model)
  }
  args.push("acp")
  const env = filterEnv(options.env)
  const spec = spawnSpec(options.binaryPath ?? "cursor", args, {
    cwd: options.cwd,
    env,
  })
  let closePromise: Promise<void> | undefined
  let closing = false
  const stdoutReady = createPromiseKit<LineSource>()
  const stderrReady = createPromiseKit<LineSource>()
  const exit = createPromiseKit<{
    code: number | null
    error?: Error | undefined
    expected: boolean
    signal: NodeJS.Signals | null
  }>()
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
