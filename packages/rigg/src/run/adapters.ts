import { dirname, isAbsolute, join } from "node:path"
import { mkdir } from "node:fs/promises"

import { renderTemplateString } from "../compile/expr"
import { canonicalizeOutputSchema, codexReviewOutputDefinition, validateOutputValue } from "../compile/schema"
import type { ActionNode, ClaudeNode, CodexNode, OutputDefinition } from "../compile/schema"
import type { ConversationSnapshot } from "../history/index"
import { isJsonObject, parseJson, stringifyJson, tryParseJson } from "../util/json"
import type { RenderContext } from "./render"
import { createStepFailedError, createTimedOutError as createRunTimedOutError } from "./error"

const PROVIDER_TIMEOUT_MS = 60 * 60 * 1000
const PROVIDER_TERMINATE_GRACE_MS = 5 * 1000

export type ProcessOutput = {
  exitCode: number
  stderr: string
  stdout: string
}

export type ActionStepOutput = {
  conversation?: ConversationSnapshot
  exitCode: number
  providerEvents: ProviderEvent[]
  result: unknown
  stderr: string
  stdout: string
}

type StreamName = "stderr" | "stdout"

export type ProviderEvent =
  | {
      detail?: string | undefined
      kind: "tool_use"
      provider: "claude" | "codex"
      tool: string
    }
  | {
      kind: "status"
      message: string
      provider: "claude" | "codex"
    }
  | {
      kind: "error"
      message: string
      provider: "claude" | "codex"
    }

export async function runActionStep(
  step: ActionNode,
  context: RenderContext,
  options: {
    artifactsDir: string
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined
    resumeConversationId?: string | undefined
  },
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
      return step.with.action === "review"
        ? runCodexReviewStep(step, context, options)
        : runCodexExecStep(step, context, options)
    case "claude":
      return runClaudeStep(step, context, options)
  }
}

async function runShellStep(
  command: string,
  options: {
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    resultMode: "json" | "none" | "text"
  },
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
    const parsed = parseJsonOutput(output.stdout, "Shell")
    return {
      ...output,
      providerEvents: [],
      result: parsed,
    }
  }

  return {
    ...output,
    providerEvents: [],
    result: output.stdout,
  }
}

async function runCodexExecStep(
  step: CodexNode,
  context: RenderContext,
  options: {
    artifactsDir: string
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined
    resumeConversationId?: string | undefined
  },
): Promise<ActionStepOutput> {
  if (step.with.action !== "exec") {
    throw new Error("expected codex exec step")
  }

  const providerEvents: ProviderEvent[] = []
  const handleProviderEvent = async (event: ProviderEvent): Promise<void> => {
    providerEvents.push(event)
    await options.onProviderEvent?.(event)
  }
  const withConfig = step.with
  const prompt = renderString(withConfig.prompt, context)
  const addDirs = (withConfig.add_dirs ?? []).map((dir: string) => renderString(dir, context))
  const codexArtifactsDir = join(options.artifactsDir, "codex")
  await mkdir(codexArtifactsDir, { recursive: true })

  const outputPath = join(codexArtifactsDir, `exec-output-${crypto.randomUUID()}.txt`)
  let schemaPath: string | undefined
  if (withConfig.output_schema !== undefined && options.resumeConversationId === undefined) {
    schemaPath = join(codexArtifactsDir, `exec-schema-${crypto.randomUUID()}.json`)
    await Bun.write(schemaPath, stringifyJson(schemaToProviderJson(withConfig.output_schema)))
  }

  const args = buildCodexExecArgs({
    addDirs,
    mode: withConfig.mode ?? "default",
    model: withConfig.model,
    outputPath,
    persistence: withConfig.persist ?? true,
    prompt,
    resumeThreadId: options.resumeConversationId,
    schemaPath,
  })

  const output = await runProcess("codex", args, {
    cwd: options.cwd,
    env: options.env,
    onOutput: options.onOutput,
    onProviderEvent: handleProviderEvent,
    stdoutParser: "codex",
    timeoutMs: PROVIDER_TIMEOUT_MS,
  })

  const parsed = parseCodexStdout(output.stdout)
  const resultText = await readOptionalText(outputPath)
  const conversation =
    withConfig.conversation === undefined || output.exitCode !== 0
      ? undefined
      : parsed.threadId === undefined
        ? options.resumeConversationId === undefined
          ? undefined
          : { id: options.resumeConversationId, provider: "codex" as const }
        : { id: parsed.threadId, provider: "codex" as const }

  if (output.exitCode !== 0) {
    return {
      ...(conversation === undefined ? {} : { conversation }),
      exitCode: output.exitCode,
      providerEvents,
      result: null,
      stderr: output.stderr,
      stdout: parsed.messageText.length > 0 ? parsed.messageText : output.stdout,
    }
  }

  if (withConfig.output_schema !== undefined) {
    const parsedResult = parseJsonOutput(resultText, "Codex")
    const validationErrors = validateOutputValue(withConfig.output_schema, parsedResult)
    if (validationErrors.length > 0) {
      throw createStepFailedError(new Error(validationErrors.join("; ")))
    }
    return {
      ...(conversation === undefined ? {} : { conversation }),
      exitCode: output.exitCode,
      providerEvents,
      result: parsedResult,
      stderr: output.stderr,
      stdout: resultText ?? stringifyJson(parsedResult),
    }
  }

  return {
    ...(conversation === undefined ? {} : { conversation }),
    exitCode: output.exitCode,
    providerEvents,
    result: resultText ?? parsed.messageText,
    stderr: output.stderr,
    stdout: resultText ?? (parsed.messageText.length > 0 ? parsed.messageText : output.stdout),
  }
}

async function runCodexReviewStep(
  step: CodexNode,
  context: RenderContext,
  options: {
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined
  },
): Promise<ActionStepOutput> {
  if (step.with.action !== "review") {
    throw new Error("expected codex review step")
  }

  const providerEvents: ProviderEvent[] = []
  const handleProviderEvent = async (event: ProviderEvent): Promise<void> => {
    providerEvents.push(event)
    await options.onProviderEvent?.(event)
  }
  const withConfig = step.with
  const prompt = withConfig.prompt === undefined ? undefined : renderString(withConfig.prompt, context)
  const title = withConfig.title === undefined ? undefined : renderString(withConfig.title, context)
  const addDirs = (withConfig.add_dirs ?? []).map((dir: string) => renderString(dir, context))
  const args = buildCodexReviewArgs({
    addDirs,
    mode: withConfig.mode ?? "default",
    model: withConfig.model,
    persistence: withConfig.persist ?? true,
    prompt,
    scope: inferReviewScope(
      withConfig.base === undefined ? undefined : renderString(withConfig.base, context),
      withConfig.commit === undefined ? undefined : renderString(withConfig.commit, context),
      withConfig.target,
    ),
    title,
  })

  const output = await runProcess("codex", args, {
    cwd: options.cwd,
    env: options.env,
    onOutput: options.onOutput,
    onProviderEvent: handleProviderEvent,
    stdoutParser: "codex",
    timeoutMs: PROVIDER_TIMEOUT_MS,
  })

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
    providerEvents,
    result: output.exitCode === 0 ? (parsed.reviewOutput ?? null) : null,
    stderr: output.stderr,
    stdout,
  }
}

async function runClaudeStep(
  step: ClaudeNode,
  context: RenderContext,
  options: {
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined
    resumeConversationId?: string | undefined
  },
): Promise<ActionStepOutput> {
  const providerEvents: ProviderEvent[] = []
  const handleProviderEvent = async (event: ProviderEvent): Promise<void> => {
    providerEvents.push(event)
    await options.onProviderEvent?.(event)
  }
  const prompt = renderString(step.with.prompt, context)
  const addDirs = (step.with.add_dirs ?? []).map((dir) => renderString(dir, context))
  const args = buildClaudeArgs({
    addDirs,
    model: step.with.model,
    permissionMode: step.with.permission_mode ?? "default",
    persistence: step.with.persist ?? true,
    prompt,
    resultSchema: step.with.output_schema === undefined ? undefined : schemaToProviderJson(step.with.output_schema),
    resumeSessionId: options.resumeConversationId,
  })

  const output = await runProcess("claude", args, {
    cwd: options.cwd,
    env: options.env,
    onOutput: options.onOutput,
    onProviderEvent: handleProviderEvent,
    stdoutParser: "claude",
    timeoutMs: PROVIDER_TIMEOUT_MS,
  })

  const parsed = parseClaudeStdout(output.stdout)
  const conversation =
    step.with.conversation === undefined || output.exitCode !== 0
      ? undefined
      : parsed.sessionId === undefined
        ? options.resumeConversationId === undefined
          ? undefined
          : { id: options.resumeConversationId, provider: "claude" as const }
        : { id: parsed.sessionId, provider: "claude" as const }

  if (output.exitCode !== 0) {
    return {
      ...(conversation === undefined ? {} : { conversation }),
      exitCode: output.exitCode,
      providerEvents,
      result: null,
      stderr: output.stderr,
      stdout: output.stdout,
    }
  }

  if (step.with.output_schema !== undefined) {
    const structured =
      parsed.structuredOutput ?? (parsed.finalMessage === undefined ? undefined : tryParseJson(parsed.finalMessage))
    if (structured === undefined) {
      throw createStepFailedError(new Error("Claude step returned invalid JSON: missing structured output"))
    }
    const validationErrors = validateOutputValue(step.with.output_schema, structured)
    if (validationErrors.length > 0) {
      throw createStepFailedError(new Error(validationErrors.join("; ")))
    }
    return {
      ...(conversation === undefined ? {} : { conversation }),
      exitCode: output.exitCode,
      providerEvents,
      result: structured,
      stderr: output.stderr,
      stdout: parsed.structuredOutputText ?? parsed.finalMessage ?? output.stdout,
    }
  }

  const text = parsed.text.length > 0 ? parsed.text : (parsed.finalMessage ?? output.stdout)
  return {
    ...(conversation === undefined ? {} : { conversation }),
    exitCode: output.exitCode,
    providerEvents,
    result: text,
    stderr: output.stderr,
    stdout: text,
  }
}

async function runWriteFileStep(path: string, content: string, cwd: string): Promise<{ path: string }> {
  const resolvedPath = isAbsolute(path) ? path : join(cwd, path)
  await mkdir(dirname(resolvedPath), { recursive: true })
  await Bun.write(resolvedPath, content)
  return { path: resolvedPath }
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: Record<string, string | undefined>
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined
    stdoutParser?: "claude" | "codex" | undefined
    timeoutMs?: number | undefined
  },
): Promise<ProcessOutput> {
  const child = spawnBufferedProcess([command, ...args], {
    cwd: options.cwd,
    env: options.env,
  })

  return runSpawnedProcess(child, options)
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

async function runSpawnedProcess(
  child: ReturnType<typeof spawnBufferedProcess>,
  options: {
    onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined
    onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined
    stdoutParser?: "claude" | "codex" | undefined
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
      collectProcessStream(child.stdout, "stdout", options.onOutput, options.stdoutParser, options.onProviderEvent),
      collectProcessStream(child.stderr, "stderr", options.onOutput),
    ])

    if (timedOut) {
      throw createProviderTimedOutError(options.timeoutMs ?? PROVIDER_TIMEOUT_MS)
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

async function collectProcessStream(
  stream: ReadableStream<Uint8Array>,
  name: StreamName,
  onOutput?: ((stream: StreamName, chunk: string) => Promise<void> | void) | undefined,
  stdoutParser?: "claude" | "codex" | undefined,
  onProviderEvent?: ((event: ProviderEvent) => Promise<void> | void) | undefined,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  const parser = name !== "stdout" || stdoutParser === undefined ? undefined : createProviderStreamParser(stdoutParser)

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
      if (parser === undefined) {
        await onOutput?.(name, text)
      } else {
        for (const event of parser.push(text)) {
          await onProviderEvent?.(event)
        }
      }
    }

    const trailingText = decoder.decode()
    if (trailingText.length > 0) {
      chunks.push(trailingText)
      if (parser === undefined) {
        await onOutput?.(name, trailingText)
      } else {
        for (const event of parser.push(trailingText)) {
          await onProviderEvent?.(event)
        }
      }
    }
    if (parser !== undefined) {
      for (const event of parser.flush()) {
        await onProviderEvent?.(event)
      }
    }

    return chunks.join("")
  } finally {
    reader.releaseLock()
  }
}

type ProviderStreamParser = {
  flush: () => ProviderEvent[]
  push: (chunk: string) => ProviderEvent[]
}

function createProviderStreamParser(provider: "claude" | "codex"): ProviderStreamParser {
  let buffer = ""
  let activeClaudeTool: { inputJson: string; tool: string } | undefined

  function processLine(line: string): ProviderEvent[] {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      return []
    }
    const object = asRecord(tryParseJson(trimmed))
    if (object === undefined) {
      return []
    }
    if (provider === "codex") {
      return parseCodexProviderEvents(object)
    }
    const events: ProviderEvent[] = []
    const nextClaudeTool = nextActiveClaudeTool(object)
    if (nextClaudeTool !== undefined) {
      if (activeClaudeTool !== undefined) {
        events.push(completeClaudeTool(activeClaudeTool))
      }
      activeClaudeTool = nextClaudeTool
      return events
    }
    const delta = asRecord(object["delta"])
    if (delta?.["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
      if (activeClaudeTool !== undefined) {
        activeClaudeTool.inputJson += delta["partial_json"]
      }
      return events
    }
    if (activeClaudeTool !== undefined) {
      events.push(completeClaudeTool(activeClaudeTool))
      activeClaudeTool = undefined
    }
    if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string" && delta["text"].trim().length > 0) {
      events.push({ kind: "status", message: delta["text"], provider: "claude" })
    } else if (object["type"] === "error" && typeof object["message"] === "string") {
      events.push({ kind: "error", message: object["message"], provider: "claude" })
    }
    return events
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
      if (provider === "claude" && activeClaudeTool !== undefined) {
        events.push(completeClaudeTool(activeClaudeTool))
        activeClaudeTool = undefined
      }
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

function nextActiveClaudeTool(object: Record<string, unknown>): { inputJson: string; tool: string } | undefined {
  const contentBlock = asRecord(object["content_block"])
  if (contentBlock?.["type"] === "tool_use" && typeof contentBlock["name"] === "string") {
    return { inputJson: "", tool: contentBlock["name"] }
  }
  const message = asRecord(object["message"])
  const toolUse = asRecord(message?.["tool_use"])
  if (toolUse !== undefined && typeof toolUse["name"] === "string") {
    return { inputJson: "", tool: toolUse["name"] }
  }
  return undefined
}

function completeClaudeTool(activeTool: { inputJson: string; tool: string }): ProviderEvent {
  return {
    detail: summarizeJsonInput(activeTool.inputJson),
    kind: "tool_use",
    provider: "claude",
    tool: activeTool.tool,
  }
}

function summarizeJsonInput(inputJson: string): string | undefined {
  if (inputJson.trim().length === 0) {
    return undefined
  }
  const parsed = tryParseJson(inputJson)
  return summarizeProviderDetail(asRecord(parsed) ?? inputJson)
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
  if (pairs.length > 0) {
    return pairs.join(" ")
  }
  return undefined
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
    // Preserve the logical working directory in shell builtins like `pwd`.
    PWD: cwd,
  }
}

function createProviderTimedOutError(timeoutMs: number): Error {
  return createRunTimedOutError(new Error(`step exceeded hard timeout of ${timeoutMs}ms`))
}

function buildCodexExecArgs(config: {
  addDirs: string[]
  mode: "default" | "full_auto"
  model?: string | undefined
  outputPath: string
  persistence: boolean
  prompt: string
  resumeThreadId?: string | undefined
  schemaPath?: string | undefined
}): string[] {
  const args = ["exec"]
  if (config.resumeThreadId !== undefined) {
    args.push("resume", config.resumeThreadId)
    pushCommonCodexArgs(args, config.model, config.mode, [], config.persistence)
  } else {
    pushCommonCodexArgs(args, config.model, config.mode, config.addDirs, config.persistence)
    if (config.schemaPath !== undefined) {
      args.push("--output-schema", config.schemaPath)
    }
  }
  args.push("-o", config.outputPath, config.prompt)
  return args
}

function buildCodexReviewArgs(config: {
  addDirs: string[]
  mode: "default" | "full_auto"
  model?: string | undefined
  persistence: boolean
  prompt?: string | undefined
  scope: { kind: "base"; value: string } | { kind: "commit"; value: string } | { kind: "uncommitted" }
  title?: string | undefined
}): string[] {
  const args = ["exec", "review"]
  pushCommonCodexArgs(args, config.model, config.mode, config.addDirs, config.persistence)
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
  if (config.prompt !== undefined) {
    args.push(config.prompt)
  }
  return args
}

function pushCommonCodexArgs(
  args: string[],
  model: string | undefined,
  mode: "default" | "full_auto",
  addDirs: string[],
  persistence: boolean,
): void {
  if (model !== undefined) {
    args.push("-m", model)
  }
  if (mode === "full_auto") {
    args.push("--full-auto")
  }
  for (const addDir of addDirs) {
    args.push("--add-dir", addDir)
  }
  if (!persistence) {
    args.push("--ephemeral")
  }
  args.push("--json")
}

function buildClaudeArgs(config: {
  addDirs: string[]
  model?: string | undefined
  permissionMode: "acceptEdits" | "bypassPermissions" | "default" | "dontAsk" | "plan"
  persistence: boolean
  prompt: string
  resultSchema?: unknown
  resumeSessionId?: string | undefined
}): string[] {
  const args = [
    "-p",
    "--permission-mode",
    config.permissionMode,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]
  if (config.model !== undefined) {
    args.push("--model", config.model)
  }
  for (const addDir of config.addDirs) {
    args.push("--add-dir", addDir)
  }
  if (!config.persistence) {
    args.push("--no-session-persistence")
  }
  if (config.resumeSessionId !== undefined) {
    args.push("--resume", config.resumeSessionId)
  }
  if (config.resultSchema !== undefined) {
    args.push("--json-schema", JSON.stringify(config.resultSchema))
  }
  args.push(config.prompt)
  return args
}

function parseCodexStdout(stdout: string): {
  messageText: string
  reviewOutput?: unknown
  reviewOutputText?: string
  threadId?: string
} {
  const messages: string[] = []
  let reviewOutput: unknown
  let reviewOutputText: string | undefined
  let pendingMessage = ""
  let threadId: string | undefined

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }

    const parsed = tryParseJson(trimmed)
    const object = asRecord(parsed)
    if (object === undefined) {
      messages.push(trimmed)
      continue
    }

    if (object["type"] === "thread.started" && typeof object["thread_id"] === "string") {
      threadId = object["thread_id"]
    }
    if (typeof object["thread_id"] === "string") {
      threadId = object["thread_id"]
    }
    if (object["provider"] === "codex" && typeof object["id"] === "string") {
      threadId = object["id"]
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
      continue
    }
  }

  if (pendingMessage.length > 0) {
    messages.push(pendingMessage)
  }

  return {
    messageText: messages.join("\n"),
    ...(reviewOutput === undefined ? {} : { reviewOutput }),
    ...(reviewOutputText === undefined ? {} : { reviewOutputText }),
    ...(threadId === undefined ? {} : { threadId }),
  }
}

function parseClaudeStdout(stdout: string): {
  finalMessage?: string
  sessionId?: string
  structuredOutput?: unknown
  structuredOutputText?: string
  text: string
} {
  let finalMessage: string | undefined
  let sessionId: string | undefined
  let structuredOutput: unknown
  let structuredOutputText: string | undefined
  let text = ""

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      continue
    }

    const parsed = tryParseJson(trimmed)
    const object = asRecord(parsed)
    if (object === undefined) {
      text += trimmed
      continue
    }

    if (typeof object["session_id"] === "string") {
      sessionId = object["session_id"]
    }

    if (object["type"] === "content_block_delta") {
      const delta = asRecord(object["delta"])
      if (delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
        text += delta["text"]
      }
      continue
    }

    if (object["type"] === "result") {
      if (typeof object["result"] === "string") {
        finalMessage = object["result"]
      }
      if ("structured_output" in object) {
        structuredOutput = object["structured_output"]
        structuredOutputText = JSON.stringify(object["structured_output"])
      }
      continue
    }

    if ("structured_output" in object) {
      structuredOutput = object["structured_output"]
      structuredOutputText = JSON.stringify(object["structured_output"])
      continue
    }
  }

  return {
    ...(finalMessage === undefined ? {} : { finalMessage }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(structuredOutput === undefined ? {} : { structuredOutput }),
    ...(structuredOutputText === undefined ? {} : { structuredOutputText }),
    text,
  }
}

function inferReviewScope(
  base: string | undefined,
  commit: string | undefined,
  target: "base" | "commit" | "uncommitted" | undefined,
): { kind: "base"; value: string } | { kind: "commit"; value: string } | { kind: "uncommitted" } {
  if ((target === "base" || target === undefined) && base !== undefined && commit === undefined) {
    return { kind: "base", value: base }
  }
  if (target === "commit" && commit !== undefined && base === undefined) {
    return { kind: "commit", value: commit }
  }
  return { kind: "uncommitted" }
}

function parseJsonOutput(text: string | undefined, source: "Claude" | "Codex" | "Shell"): unknown {
  try {
    return parseJson((text ?? "").trim())
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error))
    throw createStepFailedError(new Error(`${source} step returned invalid JSON: ${cause.message}`, { cause }))
  }
}

function renderString(template: string, context: RenderContext): string {
  try {
    return renderTemplateString(template, context)
  } catch (error) {
    throw createStepFailedError(error)
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined
}

function schemaToProviderJson(schema: OutputDefinition): unknown {
  return canonicalizeOutputSchema(schema)
}
