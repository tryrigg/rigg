import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

import { renderTemplateString } from "../compile/expr"
import type { ActionNode, CodexNode } from "../compile/schema"
import { createCodexRuntimeSession, type CodexRuntimeSession } from "../codex/runtime"
import type { CodexInteractionHandler, CodexProviderEvent } from "../codex/types"
import { filterEnv } from "../util/env"
import { parseJson } from "../util/json"
import { createStepFailedError, createTimedOutError as createRunTimedOutError } from "./error"
import type { RenderContext } from "./render"

const PROVIDER_TERMINATE_GRACE_MS = 5 * 1000

type StreamName = "stderr" | "stdout"

export type ProviderEvent = CodexProviderEvent

export type ActionStepOutput = {
  exitCode: number
  providerEvents: ProviderEvent[]
  result: unknown
  stderr: string
  stdout: string
}

export type ActionExecutionOptions = {
  codexSession?: CodexRuntimeSession | undefined
  cwd: string
  env: Record<string, string | undefined>
  interactionHandler?: CodexInteractionHandler | undefined
  onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
  onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined
}

export type ProcessOutput = {
  exitCode: number
  stderr: string
  stdout: string
}

export type StreamEventParser<TEvent> = {
  flush: () => TEvent[]
  push: (chunk: string) => TEvent[]
}

export async function runActionStep(
  step: ActionNode,
  context: RenderContext,
  options: ActionExecutionOptions,
): Promise<ActionStepOutput> {
  switch (step.type) {
    case "shell":
      return runShellStep(renderString(step.with.command, context), {
        cwd: options.cwd,
        env: options.env,
        onOutput: options.onOutput,
        resultMode: step.with.result ?? "text",
      })
    case "write_file": {
      const path = renderString(step.with.path, context)
      const content = renderString(step.with.content, context)
      return {
        exitCode: 0,
        providerEvents: [],
        result: await runWriteFileStep(path, content, options.cwd),
        stderr: "",
        stdout: "",
      }
    }
    case "codex":
      return runCodexStep(step, context, options)
  }
}

function renderString(template: string, context: RenderContext): string {
  try {
    return renderTemplateString(template, context)
  } catch (error) {
    throw createStepFailedError(error)
  }
}

async function runShellStep(
  command: string,
  options: ActionExecutionOptions & { resultMode: "json" | "none" | "text" },
): Promise<ActionStepOutput> {
  const output = await runShellProcess(command, options)

  if (output.exitCode !== 0) {
    return {
      ...output,
      providerEvents: [],
      result: null,
    }
  }

  if (options.resultMode === "none") {
    return { ...output, providerEvents: [], result: null }
  }

  if (options.resultMode === "json") {
    return {
      ...output,
      providerEvents: [],
      result: parseJsonOutput(output.stdout, "Shell"),
    }
  }

  return {
    ...output,
    providerEvents: [],
    result: output.stdout,
  }
}

async function runWriteFileStep(path: string, content: string, cwd: string): Promise<{ path: string }> {
  const resolvedPath = isAbsolute(path) ? path : join(cwd, path)
  await mkdir(dirname(resolvedPath), { recursive: true })
  await Bun.write(resolvedPath, content)
  return { path: resolvedPath }
}

async function runCodexStep(
  step: CodexNode,
  context: RenderContext,
  options: ActionExecutionOptions,
): Promise<ActionStepOutput> {
  return step.with.action === "review"
    ? runCodexReviewStep(step, context, options)
    : runCodexRunStep(step, context, options)
}

async function runCodexRunStep(
  step: CodexNode,
  context: RenderContext,
  options: ActionExecutionOptions,
): Promise<ActionStepOutput> {
  const runConfig = step.with
  if (runConfig.action !== "run") {
    throw new Error("expected codex run step")
  }

  return await withCodexSession(options, async (session) => {
    const result = await session.run({
      cwd: options.cwd,
      model: runConfig.model,
      outputSchema: runConfig.output?.schema,
      prompt: renderString(runConfig.prompt, context),
    })
    await flushProviderEvents(result.providerEvents, options.onProviderEvent)
    return result
  })
}

async function runCodexReviewStep(
  step: CodexNode,
  context: RenderContext,
  options: ActionExecutionOptions,
): Promise<ActionStepOutput> {
  const reviewConfig = step.with
  if (reviewConfig.action !== "review") {
    throw new Error("expected codex review step")
  }

  return await withCodexSession(options, async (session) => {
    const result = await session.review({
      cwd: options.cwd,
      model: reviewConfig.model,
      target: inferReviewScope(reviewConfig.review.target, context),
    })
    await flushProviderEvents(result.providerEvents, options.onProviderEvent)
    return result
  })
}

function inferReviewScope(
  target: CodexNode["with"] extends infer T
    ? T extends { action: "review"; review: { target: infer ReviewTarget } }
      ? ReviewTarget
      : never
    : never,
  context: RenderContext,
): { type: "base"; value: string } | { type: "commit"; value: string } | { type: "uncommitted" } {
  if (target.type === "base") {
    return { type: "base", value: renderString(target.branch, context) }
  }
  if (target.type === "commit") {
    return { type: "commit", value: renderString(target.sha, context) }
  }
  return { type: "uncommitted" }
}

export async function runProcess<TEvent>(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onStdoutEvent?: ((event: TEvent) => Promise<void> | void) | undefined
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
  },
): Promise<ProcessOutput> {
  const shell = resolveShellInvocation(command, options.env)
  const child = spawnBufferedProcess([shell.program, ...shell.args], {
    cwd: options.cwd,
    env: shellProcessEnv(options.cwd, options.env),
  })

  return runSpawnedProcess(child, {
    onOutput: options.onOutput,
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
    stdoutEventParser?: StreamEventParser<TEvent> | undefined
    timeoutMs?: number | undefined
  },
): Promise<ProcessOutput> {
  let timedOut = false
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
      timedOut = true
      child.kill("SIGTERM")
      graceTimer = setTimeout(() => {
        child.kill("SIGKILL")
      }, PROVIDER_TERMINATE_GRACE_MS)
    }, options.timeoutMs)
  }

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

    if (timedOut) {
      throw createProviderTimedOutError(options.timeoutMs ?? 0)
    }

    return {
      exitCode,
      stderr,
      stdout,
    }
  } finally {
    cleanupTimers()
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

function parseJsonOutput(text: string | undefined, source: "Shell"): unknown {
  try {
    return parseJson((text ?? "").trim())
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error))
    throw createStepFailedError(new Error(`${source} step returned invalid JSON: ${cause.message}`, { cause }))
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
  return createRunTimedOutError(new Error(`step exceeded hard timeout of ${timeoutMs}ms`))
}

async function withCodexSession(
  options: ActionExecutionOptions,
  action: (session: CodexRuntimeSession) => Promise<ActionStepOutput>,
): Promise<ActionStepOutput> {
  if (options.codexSession !== undefined) {
    return await action(options.codexSession)
  }

  const session = await createCodexRuntimeSession({
    cwd: options.cwd,
    env: options.env,
    interactionHandler: options.interactionHandler,
  })
  try {
    return await action(session)
  } finally {
    await session.close()
  }
}

async function flushProviderEvents(
  events: ProviderEvent[],
  onProviderEvent: ActionExecutionOptions["onProviderEvent"],
): Promise<void> {
  for (const event of events) {
    await onProviderEvent?.(event)
  }
}
