import { onAbort } from "../../util/abort"
import { filterEnv } from "../../util/env"
import { parseJsonOutput } from "../../util/json"
import type { OpencodeRuntimeInternals } from "../../provider/opencode/runtime"
import type { InteractionHandler } from "../interaction"
import type { ProviderEvent } from "../event"
import { timedOut } from "../error"

const PROVIDER_TERMINATE_GRACE_MS = 5 * 1000

type StreamName = "stderr" | "stdout"

export type ActionStepOutput = {
  exitCode: number
  providerEvents: ProviderEvent[]
  result: unknown
  stderr: string
  stdout: string
  termination: "completed" | "failed" | "interrupted"
}

export type ActionExecutionOptions = {
  cwd: string
  env: Record<string, string | undefined>
  onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
  signal?: AbortSignal | undefined
}

export type ProviderStepOptions = ActionExecutionOptions & {
  claudeSdk?: Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "query"> | undefined
  interactionHandler?: InteractionHandler | undefined
  opencodeBinaryPath?: string | undefined
  opencodeInternals?: OpencodeRuntimeInternals | undefined
  opencodeScopeId?: string | undefined
  onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined
}

export type ProcessOutput = {
  exitCode: number
  stderr: string
  stdout: string
  termination: "completed" | "interrupted"
}

export type StreamEventParser<TEvent> = {
  flush: () => TEvent[]
  push: (chunk: string) => TEvent[]
}

export async function runShellStep(
  command: string,
  options: ActionExecutionOptions & { stdoutMode: "json" | "none" | "text" },
): Promise<ActionStepOutput> {
  const output = await runShellProcess(command, options)

  if (output.exitCode !== 0) {
    return {
      ...output,
      providerEvents: [],
      result: null,
      termination: output.termination,
    }
  }

  if (options.stdoutMode === "none") {
    return { ...output, providerEvents: [], result: null, termination: output.termination }
  }

  if (options.stdoutMode === "json") {
    return {
      ...output,
      providerEvents: [],
      result: parseJsonOutput(output.stdout, "Shell"),
      termination: output.termination,
    }
  }

  return {
    ...output,
    providerEvents: [],
    result: output.stdout,
    termination: output.termination,
  }
}

export async function runProcess<TEvent>(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onStdoutEvent?: ((event: TEvent) => Promise<void> | void) | undefined
    signal?: AbortSignal | undefined
    stdoutEventParser?: StreamEventParser<TEvent> | undefined
    timeoutMs?: number | undefined
  },
): Promise<ProcessOutput> {
  const child = spawnBufferedProcess([command, ...args], {
    cwd: options.cwd,
    env: options.env,
  })

  return runSpawnedProcess(child, options)
}

async function runShellProcess(
  command: string,
  options: {
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    signal?: AbortSignal | undefined
  },
): Promise<ProcessOutput> {
  const shell = resolveShellInvocation(command, options.env)
  const child = spawnBufferedProcess([shell.program, ...shell.args], {
    cwd: options.cwd,
    env: shellProcessEnv(options.cwd, options.env),
  })

  return runSpawnedProcess(child, {
    onOutput: options.onOutput,
    signal: options.signal,
  })
}

function spawnBufferedProcess(
  cmd: string[],
  options: {
    cwd: string
    env: Record<string, string | undefined>
  },
) {
  return Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: filterEnv(options.env),
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
}

async function runSpawnedProcess<TEvent>(
  child: ReturnType<typeof spawnBufferedProcess>,
  options: {
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onStdoutEvent?: ((event: TEvent) => Promise<void> | void) | undefined
    signal?: AbortSignal | undefined
    stdoutEventParser?: StreamEventParser<TEvent> | undefined
    timeoutMs?: number | undefined
  },
): Promise<ProcessOutput> {
  let didTimeOut = false
  let interrupted = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined

  function cleanupTimers(): void {
    if (killTimer !== undefined) {
      clearTimeout(killTimer)
    }
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer)
    }
  }

  if (options.timeoutMs !== undefined) {
    killTimer = setTimeout(() => {
      didTimeOut = true
      child.kill("SIGTERM")
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL")
      }, PROVIDER_TERMINATE_GRACE_MS)
    }, options.timeoutMs)
  }

  const abortListener = () => {
    interrupted = true
    child.kill("SIGTERM")
    graceTimer = setTimeout(() => {
      child.kill("SIGKILL")
    }, PROVIDER_TERMINATE_GRACE_MS)
  }

  const disposeAbort = onAbort(options.signal, abortListener)

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      collectProcessStream(child.stdout, "stdout", {
        onOutput: options.onOutput,
        onStreamEvent: options.onStdoutEvent,
        parser: options.stdoutEventParser,
      }),
      collectProcessStream(child.stderr, "stderr", { onOutput: options.onOutput }),
    ])

    if (didTimeOut) {
      throw createProviderTimedOutError(options.timeoutMs ?? 0)
    }

    return {
      exitCode,
      stderr,
      stdout,
      termination: interrupted ? "interrupted" : "completed",
    }
  } finally {
    cleanupTimers()
    disposeAbort()
  }
}

async function collectProcessStream<TEvent>(
  stream: ReadableStream<Uint8Array>,
  name: StreamName,
  options: {
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onStreamEvent?: ((event: TEvent) => Promise<void> | void) | undefined
    parser?: StreamEventParser<TEvent> | undefined
  },
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []

  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        break
      }

      const text = decoder.decode(result.value, { stream: true })
      if (text.length === 0) {
        continue
      }

      chunks.push(text)
      await forwardProcessChunk(name, text, options)
    }

    const trailingText = decoder.decode()
    if (trailingText.length > 0) {
      chunks.push(trailingText)
      await forwardProcessChunk(name, trailingText, options)
    }

    if (name === "stdout" && options.parser !== undefined) {
      for (const event of options.parser.flush()) {
        await options.onStreamEvent?.(event)
      }
    }

    return chunks.join("")
  } finally {
    reader.releaseLock()
  }
}

async function forwardProcessChunk<TEvent>(
  name: StreamName,
  chunk: string,
  options: {
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onStreamEvent?: ((event: TEvent) => Promise<void> | void) | undefined
    parser?: StreamEventParser<TEvent> | undefined
  },
): Promise<void> {
  if (name !== "stdout" || options.parser === undefined) {
    await options.onOutput?.(name, chunk)
    return
  }

  for (const event of options.parser.push(chunk)) {
    await options.onStreamEvent?.(event)
  }
}

function resolveShellInvocation(
  command: string,
  env: Record<string, string | undefined>,
): {
  args: string[]
  program: string
} {
  if (process.platform === "win32") {
    return {
      args: ["/d", "/s", "/c", command],
      program: env["COMSPEC"] ?? process.env["COMSPEC"] ?? "cmd.exe",
    }
  }

  return {
    args: ["-lc", command],
    program: "/bin/sh",
  }
}

function shellProcessEnv(cwd: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (process.platform === "win32") {
    return env
  }

  return {
    ...env,
    PWD: cwd,
  }
}

function createProviderTimedOutError(timeoutMs: number): Error {
  return timedOut(new Error(`step exceeded hard timeout of ${timeoutMs}ms`))
}
