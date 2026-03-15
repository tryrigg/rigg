import { mkdir, rm } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { tmpdir } from "node:os"

import { renderTemplateString } from "../compile/expr"
import { codexReviewOutputDefinition, validateOutputValue } from "../compile/schema"
import type { ActionNode, CodexNode, OutputDefinition } from "../compile/schema"
import { isMissingPathError } from "../util/error"
import { isJsonObject, parseJson, stringifyJson, tryParseJson } from "../util/json"
import { createStepFailedError, createTimedOutError as createRunTimedOutError } from "./error"
import type { RenderContext } from "./render"

const PROVIDER_TIMEOUT_MS = 60 * 60 * 1000
const PROVIDER_TERMINATE_GRACE_MS = 5 * 1000

type StreamName = "stderr" | "stdout"

export type ProviderEvent =
  | {
      detail?: string | undefined
      kind: "tool_use"
      provider: "codex"
      tool: string
    }
  | {
      kind: "status"
      message: string
      provider: "codex"
    }
  | {
      kind: "error"
      message: string
      provider: "codex"
    }

export type ActionStepOutput = {
  exitCode: number
  providerEvents: ProviderEvent[]
  result: unknown
  stderr: string
  stdout: string
}

export type ActionExecutionOptions = {
  cwd: string
  env: Record<string, string | undefined>
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
  if (step.with.action !== "run") {
    throw new Error("expected codex run step")
  }

  const providerEvents = createProviderEventCollector(options.onProviderEvent)
  const outputSchema = step.with.output?.schema
  const prompt = buildCodexRunPrompt(renderString(step.with.prompt, context), outputSchema)
  const outputPath = join(tmpdir(), `rigg-codex-output-${crypto.randomUUID()}.txt`)

  try {
    const output = await runProcess("codex", buildCodexExecArgs({ model: step.with.model, outputPath, prompt }), {
      cwd: options.cwd,
      env: options.env,
      onOutput: options.onOutput,
      onStdoutEvent: providerEvents.onEvent,
      stdoutEventParser: createCodexProviderEventParser(),
      timeoutMs: PROVIDER_TIMEOUT_MS,
    })

    const parsed = parseCodexStdout(output.stdout)
    const resultText = await readOptionalText(outputPath)

    if (output.exitCode !== 0) {
      return {
        exitCode: output.exitCode,
        providerEvents: providerEvents.events,
        result: null,
        stderr: output.stderr,
        stdout: parsed.messageText.length > 0 ? parsed.messageText : output.stdout,
      }
    }

    if (outputSchema !== undefined) {
      const parsedResult = parseJsonOutput(resultText ?? parsed.messageText, "Codex")
      const validationErrors = validateOutputValue(outputSchema, parsedResult)
      if (validationErrors.length > 0) {
        throw createStepFailedError(new Error(validationErrors.join("; ")))
      }
      return {
        exitCode: output.exitCode,
        providerEvents: providerEvents.events,
        result: parsedResult,
        stderr: output.stderr,
        stdout: resultText ?? stringifyJson(parsedResult),
      }
    }

    return {
      exitCode: output.exitCode,
      providerEvents: providerEvents.events,
      result: resultText ?? parsed.messageText,
      stderr: output.stderr,
      stdout: resultText ?? (parsed.messageText.length > 0 ? parsed.messageText : output.stdout),
    }
  } finally {
    await rm(outputPath, { force: true })
  }
}

async function runCodexReviewStep(
  step: CodexNode,
  context: RenderContext,
  options: ActionExecutionOptions,
): Promise<ActionStepOutput> {
  if (step.with.action !== "review") {
    throw new Error("expected codex review step")
  }

  const providerEvents = createProviderEventCollector(options.onProviderEvent)
  const title = step.with.review.title === undefined ? undefined : renderString(step.with.review.title, context)
  const output = await runProcess(
    "codex",
    buildCodexReviewArgs({
      model: step.with.model,
      scope: inferReviewScope(step.with.review.target, context),
      title,
    }),
    {
      cwd: options.cwd,
      env: options.env,
      onOutput: options.onOutput,
      onStdoutEvent: providerEvents.onEvent,
      stdoutEventParser: createCodexProviderEventParser(),
      timeoutMs: PROVIDER_TIMEOUT_MS,
    },
  )

  const parsed = parseCodexStdout(output.stdout)
  const stdout = parsed.reviewOutputText ?? (parsed.messageText.length > 0 ? parsed.messageText : output.stdout)

  if (output.exitCode === 0 && parsed.reviewOutput === undefined) {
    throw createStepFailedError(new Error("Codex review returned invalid JSON: missing review output"))
  }

  if (output.exitCode === 0 && parsed.reviewOutput !== undefined) {
    const validationErrors = validateOutputValue(codexReviewOutputDefinition(), parsed.reviewOutput)
    if (validationErrors.length > 0) {
      throw createStepFailedError(new Error(validationErrors.join("; ")))
    }
  }

  return {
    exitCode: output.exitCode,
    providerEvents: providerEvents.events,
    result: output.exitCode === 0 ? (parsed.reviewOutput ?? null) : null,
    stderr: output.stderr,
    stdout,
  }
}

function createProviderEventCollector(onProviderEvent: ActionExecutionOptions["onProviderEvent"]): {
  events: ProviderEvent[]
  onEvent: (event: ProviderEvent) => Promise<void>
} {
  const events: ProviderEvent[] = []

  return {
    events,
    async onEvent(event): Promise<void> {
      events.push(event)
      await onProviderEvent?.(event)
    },
  }
}

function buildCodexExecArgs(config: { model?: string | undefined; outputPath: string; prompt: string }): string[] {
  const args = ["exec"]
  pushCommonCodexArgs(args, config.model)
  args.push("-o", config.outputPath, config.prompt)
  return args
}

function buildCodexReviewArgs(config: {
  model?: string | undefined
  scope: { kind: "base"; value: string } | { kind: "commit"; value: string } | { kind: "uncommitted" }
  title?: string | undefined
}): string[] {
  const args = ["exec", "review"]
  pushCommonCodexArgs(args, config.model)
  if (config.scope.kind === "uncommitted") {
    args.push("--uncommitted")
  } else if (config.scope.kind === "base") {
    args.push("--base", config.scope.value)
  } else {
    args.push("--commit", config.scope.value)
  }
  if (config.title !== undefined) {
    args.push("--title", config.title)
  }
  return args
}

function pushCommonCodexArgs(args: string[], model: string | undefined): void {
  if (model !== undefined) {
    args.push("-m", model)
  }
  args.push("--json")
}

function inferReviewScope(
  target: CodexNode["with"] extends infer T
    ? T extends { action: "review"; review: { target: infer ReviewTarget } }
      ? ReviewTarget
      : never
    : never,
  context: RenderContext,
): { kind: "base"; value: string } | { kind: "commit"; value: string } | { kind: "uncommitted" } {
  if (target.type === "base") {
    return { kind: "base", value: renderString(target.branch, context) }
  }
  if (target.type === "commit") {
    return { kind: "commit", value: renderString(target.sha, context) }
  }
  return { kind: "uncommitted" }
}

function buildCodexRunPrompt(prompt: string, outputSchema: OutputDefinition | undefined): string {
  if (outputSchema === undefined) {
    return prompt
  }

  return [prompt, "", "Return only a JSON object that matches this schema exactly.", stringifyJson(outputSchema)].join(
    "\n",
  )
}

function createCodexProviderEventParser(): StreamEventParser<ProviderEvent> {
  let buffer = ""

  function processLine(line: string): ProviderEvent[] {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      return []
    }
    const object = asRecord(tryParseJson(trimmed))
    if (object === undefined) {
      return []
    }
    return parseCodexProviderEvents(object)
  }

  return {
    push(chunk: string): ProviderEvent[] {
      buffer += chunk
      const events: ProviderEvent[] = []
      while (true) {
        const newlineIndex = buffer.search(/\r?\n/)
        if (newlineIndex < 0) {
          break
        }
        const line = buffer.slice(0, newlineIndex)
        const nextIndex =
          buffer[newlineIndex] === "\r" && buffer[newlineIndex + 1] === "\n" ? newlineIndex + 2 : newlineIndex + 1
        buffer = buffer.slice(nextIndex)
        events.push(...processLine(line))
      }
      return events
    },
    flush(): ProviderEvent[] {
      const events = buffer.trim().length === 0 ? [] : processLine(buffer)
      buffer = ""
      return events
    },
  }
}

function parseCodexProviderEvents(object: Record<string, unknown>): ProviderEvent[] {
  const toolEvent = parseCodexToolEvent(object)
  if (toolEvent !== undefined) {
    return [toolEvent]
  }

  if (object["type"] === "thread.started" && typeof object["thread_id"] === "string") {
    return [{ kind: "status", message: `thread started ${object["thread_id"]}`, provider: "codex" }]
  }

  if (object["type"] === "agent_message_delta") {
    const delta = asRecord(object["delta"])
    if (delta !== undefined && typeof delta["text"] === "string" && delta["text"].trim().length > 0) {
      return [{ kind: "status", message: delta["text"], provider: "codex" }]
    }
  }

  if (object["type"] === "error" && typeof object["message"] === "string") {
    return [{ kind: "error", message: object["message"], provider: "codex" }]
  }

  return []
}

function parseCodexToolEvent(object: Record<string, unknown>): ProviderEvent | undefined {
  const item = asRecord(object["item"])
  if (item !== undefined) {
    const namedTool =
      typeof item["name"] === "string" ? item["name"] : typeof item["tool"] === "string" ? item["tool"] : undefined
    if (namedTool !== undefined) {
      return {
        detail: summarizeProviderDetail(item),
        kind: "tool_use",
        provider: "codex",
        tool: namedTool,
      }
    }
  }

  const tool =
    typeof object["tool"] === "string"
      ? object["tool"]
      : typeof object["tool_name"] === "string"
        ? object["tool_name"]
        : undefined
  if (tool === undefined) {
    return undefined
  }

  return {
    detail: summarizeProviderDetail(asRecord(object["payload"]) ?? object),
    kind: "tool_use",
    provider: "codex",
    tool,
  }
}

function summarizeProviderDetail(value: Record<string, unknown> | string): string | undefined {
  if (typeof value === "string") {
    return value.trim().length === 0 ? undefined : value
  }

  const pairs = ["path", "query", "url", "command"]
    .map((key) => {
      const candidate = value[key]
      return typeof candidate === "string" && candidate.length > 0 ? `${key}=${candidate}` : undefined
    })
    .filter((candidate): candidate is string => candidate !== undefined)
  return pairs.length > 0 ? pairs.join(" ") : undefined
}

function parseCodexStdout(stdout: string): {
  messageText: string
  reviewOutput?: unknown
  reviewOutputText?: string
} {
  const messages: string[] = []
  let reviewOutput: unknown
  let reviewOutputText: string | undefined
  let pendingMessage = ""

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }

    const object = asRecord(tryParseJson(trimmed))
    if (object === undefined) {
      messages.push(trimmed)
      continue
    }

    if (object["type"] === "agent_message_delta") {
      const delta = asRecord(object["delta"])
      if (delta !== undefined && typeof delta["text"] === "string") {
        pendingMessage += delta["text"]
      }
      continue
    }

    if (object["type"] === "item.completed") {
      const item = asRecord(object["item"])
      if (item !== undefined && item["type"] === "agent_message" && typeof item["text"] === "string") {
        messages.push(item["text"])
        pendingMessage = ""
        continue
      }
    }

    if (object["type"] === "exited_review_mode" && "review_output" in object) {
      reviewOutput = object["review_output"]
      reviewOutputText = JSON.stringify(object["review_output"])
      continue
    }

    if (object["type"] === "error" && typeof object["message"] === "string") {
      messages.push(object["message"])
    }
  }

  if (pendingMessage.length > 0) {
    messages.push(pendingMessage)
  }

  return {
    messageText: messages.join("\n"),
    ...(reviewOutput === undefined ? {} : { reviewOutput }),
    ...(reviewOutputText === undefined ? {} : { reviewOutputText }),
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
    env: filterProcessEnv(options.env),
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
}

function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
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

function parseJsonOutput(text: string | undefined, source: "Codex" | "Shell"): unknown {
  try {
    return parseJson((text ?? "").trim())
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error))
    throw createStepFailedError(new Error(`${source} step returned invalid JSON: ${cause.message}`, { cause }))
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text()
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined
}
