import {
  query as defaultQuery,
  type ElicitationRequest,
  type ElicitationResult,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk"

import type { ClaudeProviderEvent } from "./event"
import { assertVersion, resolveBinaryPath, type ClaudeProcessOptions } from "./proc"
import { onAbort } from "../util/abort"
import { createAbortError, isAbortError, normalizeError } from "../util/error"
import type {
  ApprovalRequest,
  InteractionRequest,
  InteractionResolution,
  InteractionHandler,
  UserInputRequest,
} from "../session/interaction"
import type { ActionStepOutput } from "../session/step"

type ClaudeRuntimeOptions = ClaudeProcessOptions & {
  signal?: AbortSignal | undefined
  sdk?: Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "query"> | undefined
}

type ClaudeSessionCapture = {
  diagnostics: string[]
  providerEvents: ClaudeProviderEvent[]
}

type ClaudeRuntimeSession = {
  close: () => Promise<void>
  interrupt: () => Promise<void>
  run: (input: {
    cwd: string
    effort?: "low" | "medium" | "high" | undefined
    interactionHandler?: InteractionHandler | undefined
    maxThinkingTokens?: number | undefined
    maxTurns?: number | undefined
    model?: string | undefined
    onEvent?: ((event: ClaudeProviderEvent) => Promise<void> | void) | undefined
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }) => Promise<ActionStepOutput>
}

type ActiveTurn = {
  abortController: AbortController
  capture: ClaudeSessionCapture
  id: string
  interactionHandler?: InteractionHandler | undefined
  onEvent?: ((event: ClaudeProviderEvent) => Promise<void> | void) | undefined
  query: Query
  sessionId: string
  wasInterrupted: boolean
}

type PendingTool = {
  detail?: string | undefined
  tool: string
}

type UserInputPrompt = {
  fields: Record<string, Record<string, unknown>>
  request: UserInputRequest
}

type StreamMessage = {
  id: string
  text: string
}

export async function createClaudeRuntimeSession(options: ClaudeRuntimeOptions): Promise<ClaudeRuntimeSession> {
  let active: ActiveTurn | null = null
  let checkedVersion = false
  let closed = false

  async function close(): Promise<void> {
    if (closed) {
      return
    }
    closed = true
    active?.query.close()
    active = null
  }

  async function interrupt(): Promise<void> {
    const turn = active
    if (turn === null) {
      return
    }
    turn.wasInterrupted = true

    try {
      await turn.query.interrupt()
    } catch (error) {
      if (!isAbortError(error)) {
        throw error
      }
    }
  }

  async function run(input: {
    cwd: string
    effort?: "low" | "medium" | "high" | undefined
    interactionHandler?: InteractionHandler | undefined
    maxThinkingTokens?: number | undefined
    maxTurns?: number | undefined
    model?: string | undefined
    onEvent?: ((event: ClaudeProviderEvent) => Promise<void> | void) | undefined
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }): Promise<ActionStepOutput> {
    if (closed) {
      throw new Error("claude runtime session closed")
    }
    if (active !== null) {
      throw new Error("claude runtime session already has an active query")
    }
    if (!checkedVersion && options.sdk === undefined) {
      assertVersion(options)
      checkedVersion = true
    }

    const capture: ClaudeSessionCapture = { diagnostics: [], providerEvents: [] }
    const abortController = new AbortController()
    const signal = input.signal ?? options.signal
    const disposeAbort = onAbort(signal, () => abortController.abort(signal?.reason))
    const pendingTools = new Map<string, PendingTool>()
    const messageText = new Map<string, string>()
    const streamedText: string[] = []
    let stream: StreamMessage | null = null
    const sdk = options.sdk ?? { query: defaultQuery }
    const binaryPath = options.sdk === undefined ? resolveBinaryPath(options) : undefined
    const turnId = `claude-${Bun.randomUUIDv7()}`
    const query = sdk.query({
      prompt: input.prompt,
      options: buildQueryOptions(
        options,
        input,
        binaryPath,
        abortController,
        async (tool, value, extra) => {
          return await resolvePermissionRequest(input.interactionHandler, {
            description: extra.description,
            input: value,
            sessionId: currentTurnId(active, turnId),
            signal: extra.signal,
            tool,
            toolUseID: extra.toolUseID,
            title: extra.title,
          })
        },
        async (request, extra) => {
          return await resolveElicitationRequest(
            input.interactionHandler,
            currentTurnId(active, turnId),
            request,
            extra.signal,
          )
        },
      ),
    })
    const turn: ActiveTurn = {
      abortController,
      capture,
      id: turnId,
      interactionHandler: input.interactionHandler,
      onEvent: input.onEvent,
      query,
      sessionId: "",
      wasInterrupted: false,
    }
    active = turn

    let resultText = ""
    let resultError: string | null = null
    let interrupted = false
    let sawResult = false

    try {
      for await (const message of query) {
        if (closed) {
          break
        }
        if (message.session_id.length > 0 && turn.sessionId.length === 0) {
          turn.sessionId = message.session_id
        }
        stream = await handleMessage(turn, message, pendingTools, messageText, streamedText, stream)
        if (message.type !== "result") {
          continue
        }

        resultText = message.type === "result" && message.subtype === "success" ? message.result : ""
        sawResult = true
        if (message.subtype !== "success") {
          resultError = normalizeProviderError(message.errors.join("\n"))
        }
      }
    } catch (error) {
      const normalized = normalizeError(error)
      if (abortController.signal.aborted || isAbortError(normalized)) {
        interrupted = true
      } else {
        resultError = normalizeProviderError(normalized.message)
      }
    } finally {
      interrupted = interrupted || turn.wasInterrupted || abortController.signal.aborted
      disposeAbort()
      query.close()
      active = null
    }

    if (!interrupted && !sawResult && resultError === null) {
      resultError = "Claude turn ended before emitting a result."
    }

    const preservedText = [...messageText.values()].join("\n").trim()
    const fallbackText = streamedText.join("").trim()
    const finalText = (
      resultText.length > 0 ? resultText : preservedText.length > 0 ? preservedText : fallbackText
    ).trim()
    const stderr = joinDiagnostics(capture.diagnostics, resultError)

    if (interrupted) {
      return {
        exitCode: 130,
        providerEvents: [...capture.providerEvents],
        result: null,
        stderr,
        stdout: finalText,
        termination: "interrupted",
      }
    }
    if (resultError !== null) {
      return {
        exitCode: 1,
        providerEvents: [...capture.providerEvents],
        result: null,
        stderr,
        stdout: finalText,
        termination: "failed",
      }
    }

    return {
      exitCode: 0,
      providerEvents: [...capture.providerEvents],
      result: finalText,
      stderr: capture.diagnostics.join("\n"),
      stdout: finalText,
      termination: "completed",
    }
  }

  return {
    close,
    interrupt,
    run,
  }
}

function buildQueryOptions(
  options: ClaudeRuntimeOptions,
  input: Parameters<ClaudeRuntimeSession["run"]>[0],
  binaryPath: string | undefined,
  abortController: AbortController,
  canUseTool: NonNullable<Options["canUseTool"]>,
  onElicitation: NonNullable<Options["onElicitation"]>,
): Options {
  const queryOptions: Options = {
    abortController,
    allowDangerouslySkipPermissions: input.permissionMode === "bypassPermissions",
    canUseTool,
    cwd: input.cwd,
    env: options.env,
    includePartialMessages: true,
    onElicitation,
  }

  if (binaryPath !== undefined) {
    queryOptions.pathToClaudeCodeExecutable = binaryPath
  }

  if (input.effort !== undefined) {
    queryOptions.effort = input.effort
  }
  if (input.maxThinkingTokens !== undefined) {
    queryOptions.maxThinkingTokens = input.maxThinkingTokens
  }
  if (input.maxTurns !== undefined) {
    queryOptions.maxTurns = input.maxTurns
  }
  if (input.model !== undefined) {
    queryOptions.model = input.model
  }
  if (input.permissionMode !== undefined) {
    queryOptions.permissionMode = input.permissionMode
  }

  return queryOptions
}

async function handleMessage(
  turn: ActiveTurn,
  message: SDKMessage,
  pendingTools: Map<string, PendingTool>,
  messageText: Map<string, string>,
  streamedText: string[],
  stream: StreamMessage | null,
): Promise<StreamMessage | null> {
  if (message.type === "system" && message.subtype === "init") {
    turn.sessionId = message.session_id
    await emit(turn, {
      cwd: message.cwd,
      kind: "session_started",
      model: message.model,
      provider: "claude",
      sessionId: message.session_id,
    })
    return stream
  }

  if (message.type === "stream_event") {
    const delta = extractTextDelta(message.event)
    if (delta === null) {
      return stream
    }
    const next = appendStreamMessage(stream, messageText, message, delta)
    streamedText.push(delta)
    await emit(turn, {
      kind: "message_delta",
      messageId: next.id,
      provider: "claude",
      sessionId: message.session_id,
      text: delta,
    })
    return next
  }

  if (message.type === "assistant") {
    const messageId = resolveAssistantMessageId(message, stream)
    const text = extractAssistantText(message)
    let nextStream: StreamMessage | null = stream
    if (text.length > 0) {
      messageText.set(messageId, text)
      await emit(turn, {
        kind: "message_completed",
        messageId,
        provider: "claude",
        sessionId: message.session_id,
        text,
      })
      nextStream = null
    }

    for (const tool of extractAssistantTools(message)) {
      pendingTools.set(tool.id, { detail: tool.detail, tool: tool.name })
      await emit(turn, {
        detail: tool.detail,
        kind: "tool_started",
        provider: "claude",
        sessionId: message.session_id,
        tool: tool.name,
      })
    }

    if (message.error !== undefined) {
      const error = normalizeProviderError(message.error)
      turn.capture.diagnostics.push(error)
      await emit(turn, {
        kind: "error",
        message: error,
        provider: "claude",
        sessionId: message.session_id,
      })
    }
    return nextStream
  }

  if (message.type === "tool_progress") {
    if (pendingTools.has(message.tool_use_id)) {
      return stream
    }
    pendingTools.set(message.tool_use_id, { tool: message.tool_name })
    await emit(turn, {
      kind: "tool_started",
      provider: "claude",
      sessionId: message.session_id,
      tool: message.tool_name,
    })
    return stream
  }

  if (message.type === "tool_use_summary") {
    for (const toolUseId of message.preceding_tool_use_ids) {
      const tool = pendingTools.get(toolUseId)
      pendingTools.delete(toolUseId)
      await emit(turn, {
        detail: message.summary,
        kind: "tool_completed",
        provider: "claude",
        sessionId: message.session_id,
        tool: tool?.tool ?? "tool",
      })
    }
    return stream
  }

  if (message.type === "auth_status") {
    const lines = [...message.output, message.error].filter(
      (line): line is string => typeof line === "string" && line.length > 0,
    )
    for (const line of lines) {
      const normalized = normalizeProviderError(line)
      turn.capture.diagnostics.push(normalized)
      await emit(turn, {
        kind: message.error ? "error" : "diagnostic",
        message: normalized,
        provider: "claude",
        sessionId: message.session_id,
      })
    }
    return stream
  }

  if (message.type === "result") {
    await emit(turn, {
      kind: "session_completed",
      provider: "claude",
      sessionId: message.session_id,
      status: message.subtype === "success" ? "completed" : message.subtype,
    })
    return stream
  }

  return stream
}

async function emit(turn: ActiveTurn, event: ClaudeProviderEvent): Promise<void> {
  turn.capture.providerEvents.push(event)
  await turn.onEvent?.(event)
}

async function resolvePermissionRequest(
  interactionHandler: InteractionHandler | undefined,
  input: {
    description?: string | undefined
    input: Record<string, unknown>
    sessionId: string
    signal?: AbortSignal | undefined
    title?: string | undefined
    tool: string
    toolUseID: string
  },
): Promise<PermissionResult> {
  if (interactionHandler === undefined) {
    throw new Error("claude runtime requested approval, but no interaction handler is configured")
  }

  const request = createApprovalRequest(input)
  const resolution = await raceInteraction(input.signal, () => interactionHandler(request))
  assertResolutionKind("approval", resolution)
  assertApprovalDecision(request, resolution.decision)
  return approvalResponse(request, resolution.decision)
}

async function resolveElicitationRequest(
  interactionHandler: InteractionHandler | undefined,
  sessionId: string,
  request: ElicitationRequest,
  signal: AbortSignal,
): Promise<ElicitationResult> {
  if (interactionHandler === undefined) {
    throw new Error("claude runtime requested user input, but no interaction handler is configured")
  }

  const prompt = createUserInputRequest(sessionId, request)
  if (prompt !== null) {
    const resolution = await raceInteraction(signal, () => interactionHandler(prompt.request))
    assertResolutionKind("user_input", resolution)
    return {
      action: "accept",
      content: answersToElicitationContent(resolution, prompt),
    }
  }

  const elicitationRequest: Extract<InteractionRequest, { kind: "elicitation" }> =
    request.mode === "url"
      ? {
          elicitationId: request.elicitationId ?? "",
          itemId: null,
          kind: "elicitation",
          message: request.message,
          mode: "url",
          requestId: `claude:${sessionId}:elicitation`,
          serverName: request.serverName,
          turnId: sessionId,
          url: request.url ?? "",
        }
      : {
          itemId: null,
          kind: "elicitation",
          message: request.message,
          mode: "form",
          requestId: `claude:${sessionId}:elicitation`,
          requestedSchema: request.requestedSchema ?? {},
          serverName: request.serverName,
          turnId: sessionId,
        }

  signal.throwIfAborted()
  const resolution = await raceInteraction(signal, () => interactionHandler(elicitationRequest))
  assertResolutionKind("elicitation", resolution)
  return {
    action: resolution.action,
    content: resolution.content,
  }
}

function createApprovalRequest(input: {
  description?: string | undefined
  input: Record<string, unknown>
  sessionId: string
  title?: string | undefined
  tool: string
  toolUseID: string
}): ApprovalRequest {
  const command = typeof input.input["command"] === "string" ? input.input["command"] : null
  const cwd = typeof input.input["cwd"] === "string" ? input.input["cwd"] : null
  const detail = summarizeToolInput(input.tool, input.input)
  const requestKind = inferRequestKind(input.tool)

  return {
    command,
    cwd,
    decisions: [
      {
        intent: "approve",
        label: "Approve",
        response: { behavior: "allow", toolUseID: input.toolUseID },
        value: "allow",
      },
      {
        intent: "deny",
        label: "Deny",
        response: { behavior: "deny", message: "Denied by operator.", toolUseID: input.toolUseID },
        value: "deny",
      },
      {
        intent: "cancel",
        label: "Cancel",
        response: {
          behavior: "deny",
          interrupt: true,
          message: "Cancelled by operator.",
          toolUseID: input.toolUseID,
        },
        value: "cancel",
      },
    ],
    itemId: input.toolUseID,
    kind: "approval",
    message: input.title ?? input.description ?? `Claude wants to use ${input.tool}: ${detail}`,
    requestId: `claude:${input.sessionId}:${input.toolUseID}`,
    requestKind,
    turnId: input.sessionId,
  }
}

function inferRequestKind(tool: string): ApprovalRequest["requestKind"] {
  if (tool === "Bash") {
    return "command_execution"
  }
  if (tool === "FileEdit" || tool === "FileWrite" || tool === "NotebookEdit") {
    return "file_change"
  }
  return "permissions"
}

function createUserInputRequest(sessionId: string, request: ElicitationRequest): UserInputPrompt | null {
  if (request.mode === "url") {
    return null
  }
  const properties = request.requestedSchema?.["properties"]
  if (properties === undefined || properties === null || typeof properties !== "object") {
    return null
  }

  const required = Array.isArray(request.requestedSchema?.["required"])
    ? request.requestedSchema["required"].filter((item): item is string => typeof item === "string")
    : []
  const entries = Object.entries(properties)
    .map(([id, value]) => createQuestion(id, value, request.message, required.includes(id)))
    .filter(
      (entry): entry is { question: UserInputRequest["questions"][number]; schema: Record<string, unknown> } =>
        entry !== null,
    )
  const questions = entries.map((entry) => entry.question)
  if (questions.length === 0) {
    return null
  }

  return {
    fields: Object.fromEntries(entries.map((entry) => [entry.question.id, entry.schema])),
    request: {
      itemId: sessionId,
      kind: "user_input",
      questions,
      requestId: `claude:${sessionId}:question`,
      turnId: sessionId,
    },
  }
}

function createQuestion(
  id: string,
  value: unknown,
  fallbackQuestion: string,
  required: boolean,
): { question: UserInputRequest["questions"][number]; schema: Record<string, unknown> } | null {
  const schema = record(value)
  if (schema === null) {
    return null
  }

  const title = typeof schema["title"] === "string" && schema["title"].length > 0 ? schema["title"] : id
  const question =
    typeof schema["description"] === "string" && schema["description"].length > 0
      ? ensureQuestion(schema["description"])
      : ensureQuestion(fallbackQuestion)
  const options = parseQuestionOptions(schema)

  return {
    question: {
      allowEmpty: !required,
      header: title.slice(0, 12),
      id,
      initialValue: defaultValue(schema),
      isOther: false,
      isSecret: false,
      options,
      preserveWhitespace: true,
      question,
    },
    schema,
  }
}

function parseQuestionOptions(schema: Record<string, unknown>): Array<{ description: string; label: string }> | null {
  const oneOf = Array.isArray(schema["oneOf"]) ? schema["oneOf"] : null
  if (oneOf !== null) {
    const options = oneOf
      .map((item) => {
        const option = record(item)
        if (option === null) {
          return null
        }
        const label = typeof option["title"] === "string" ? option["title"] : scalarLabel(option["const"])
        if (label === null) {
          return null
        }
        return {
          description: "",
          label,
        }
      })
      .filter((item): item is { description: string; label: string } => item !== null)
    return options.length > 0 ? options : null
  }

  const values = Array.isArray(schema["enum"]) ? schema["enum"] : null
  if (values === null) {
    return null
  }

  const options = values
    .map((item) => scalarLabel(item))
    .filter((label): label is string => label !== null)
    .map((label) => ({ description: "", label }))
  return options.length > 0 ? options : null
}

function answersToElicitationContent(
  resolution: Extract<InteractionResolution, { kind: "user_input" }>,
  prompt: UserInputPrompt,
): Record<string, unknown> {
  const content: Record<string, unknown> = {}
  for (const question of prompt.request.questions) {
    const answer = resolution.answers[question.id]?.answers ?? []
    if (answer.length === 0) {
      continue
    }
    const schema = prompt.fields[question.id]
    content[question.id] = coerceAnswer(schema, answer)
  }
  return content
}

function defaultValue(schema: Record<string, unknown>): string | undefined {
  return scalarLabel(schema["default"]) ?? undefined
}

function scalarLabel(value: unknown): string | null {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return null
}

function coerceAnswer(schema: Record<string, unknown> | undefined, answers: string[]): unknown {
  const oneOf = Array.isArray(schema?.["oneOf"]) ? schema["oneOf"] : null
  if (oneOf !== null) {
    const matches = oneOf
      .map((item) => {
        const option = record(item)
        if (option === null) {
          return null
        }
        const label = typeof option["title"] === "string" ? option["title"] : scalarLabel(option["const"])
        if (label === null || !answers.includes(label) || !("const" in option)) {
          return null
        }
        return option["const"]
      })
      .filter((item) => item !== null)
    if (matches.length > 0) {
      return matches.length === 1 ? matches[0] : matches
    }
  }

  const enumValues = Array.isArray(schema?.["enum"]) ? schema["enum"] : null
  if (enumValues !== null) {
    const matches = enumValues.filter((item) => {
      const label = scalarLabel(item)
      return label !== null && answers.includes(label)
    })
    if (matches.length > 0) {
      return matches.length === 1 ? matches[0] : matches
    }
  }

  const type = schema?.["type"]
  if (type === "boolean") {
    return answers[0] === "true"
  }
  if (type === "integer" || type === "number") {
    const value = Number(answers[0])
    return Number.isNaN(value) ? answers[0] : value
  }
  if (type === "array") {
    return answers
  }
  return answers[0]
}

function extractTextDelta(event: unknown): string | null {
  const value = record(event)
  if (value === null) {
    return null
  }

  if (value["type"] !== "content_block_delta") {
    return null
  }
  const delta = record(value["delta"])
  if (delta === null) {
    return null
  }
  return delta["type"] === "text_delta" && typeof delta["text"] === "string" ? delta["text"] : null
}

function extractAssistantText(message: Extract<SDKMessage, { type: "assistant" }>): string {
  return recordArray(message.message.content)
    .flatMap((item) => (item["type"] === "text" && typeof item["text"] === "string" ? [item["text"]] : []))
    .join("")
}

function extractAssistantTools(
  message: Extract<SDKMessage, { type: "assistant" }>,
): Array<{ detail?: string | undefined; id: string; name: string }> {
  return recordArray(message.message.content).flatMap((item) => {
    if (item["type"] !== "tool_use") {
      return []
    }
    const id = item["id"]
    const name = item["name"]
    if (typeof id !== "string" || typeof name !== "string") {
      return []
    }
    return [
      {
        detail: summarizeToolInput(name, item["input"]),
        id,
        name,
      },
    ]
  })
}

function summarizeToolInput(tool: string, input: unknown): string {
  const payload = record(input)
  if (payload !== null) {
    const command = payload["command"]
    if (typeof command === "string") {
      return command
    }
  }

  let detail = ""
  try {
    detail = JSON.stringify(input)
  } catch {
    detail = String(input)
  }

  const next = `${tool} (${detail})`
  return next.length > 160 ? `${next.slice(0, 157)}...` : next
}

function normalizeProviderError(message: string): string {
  if (isAuthFailure(message)) {
    return "Claude CLI is not authenticated. Run `claude login` to authenticate, then retry."
  }
  return message
}

function isAuthFailure(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes("authentication_failed") ||
    lower.includes("not authenticated") ||
    lower.includes("claude login") ||
    lower.includes("oauth") ||
    lower.includes("login required")
  )
}

function joinDiagnostics(diagnostics: string[], error: string | null): string {
  const lines = [...diagnostics]
  if (error !== null && !lines.includes(error)) {
    lines.push(error)
  }
  return lines.join("\n")
}

function ensureQuestion(value: string): string {
  return value.trim().endsWith("?") ? value.trim() : `${value.trim()}?`
}

async function raceInteraction<T>(signal: AbortSignal | undefined, run: () => Promise<T> | T): Promise<T> {
  if (signal === undefined) {
    return await run()
  }
  signal.throwIfAborted()

  let dispose = () => {}
  const aborted = new Promise<never>((_, reject) => {
    dispose = onAbort(signal, () => reject(createAbortError(signal.reason)))
  })

  try {
    return await Promise.race([Promise.resolve(run()), aborted])
  } finally {
    dispose()
  }
}

function appendStreamMessage(
  stream: StreamMessage | null,
  messageText: Map<string, string>,
  message: Extract<SDKMessage, { type: "stream_event" }>,
  delta: string,
): StreamMessage {
  const id = streamMessageId(message) ?? stream?.id ?? message.uuid
  const text = `${stream?.text ?? messageText.get(id) ?? ""}${delta}`
  if (stream !== null && stream.id !== id) {
    messageText.delete(stream.id)
  }
  messageText.set(id, text)
  return { id, text }
}

function resolveAssistantMessageId(
  message: Extract<SDKMessage, { type: "assistant" }>,
  stream: StreamMessage | null,
): string {
  if (stream !== null) {
    return stream.id
  }
  const id = assistantMessageId(message)
  if (id !== null) {
    return id
  }
  return message.session_id
}

function streamMessageId(message: Extract<SDKMessage, { type: "stream_event" }>): string | null {
  return firstString([
    recordValue(message, "message_id"),
    recordValue(message.event, "message_id"),
    recordValue(recordValue(message.event, "message"), "id"),
    recordValue(message, "parent_message_uuid"),
  ])
}

function assistantMessageId(message: Extract<SDKMessage, { type: "assistant" }>): string | null {
  return firstString([recordValue(message.message, "id"), message.uuid])
}

function firstString(values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return Object.fromEntries(Object.entries(value))
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    const next = record(item)
    return next === null ? [] : [next]
  })
}

function recordValue(value: unknown, key: string): unknown {
  return record(value)?.[key] ?? null
}

function currentTurnId(active: ActiveTurn | null, turnId: string): string {
  if (active === null) {
    return turnId
  }
  return active.sessionId.length > 0 ? active.sessionId : active.id
}

function assertResolutionKind<TKind extends InteractionRequest["kind"]>(
  expected: TKind,
  resolution: InteractionResolution,
): asserts resolution is Extract<InteractionResolution, { kind: TKind }> {
  if (resolution.kind !== expected) {
    throw new Error(`interaction handler returned ${resolution.kind} for ${expected}`)
  }
}

function assertApprovalDecision(request: ApprovalRequest, decision: string): void {
  if (request.decisions.some((candidate) => candidate.value === decision)) {
    return
  }
  throw new Error(`interaction handler returned invalid approval decision: ${decision}`)
}

function isPermissionResult(value: unknown): value is PermissionResult {
  const result = record(value)
  return result?.["behavior"] === "allow" || result?.["behavior"] === "ask" || result?.["behavior"] === "deny"
}

function approvalResponse(request: ApprovalRequest, decision: string): PermissionResult {
  const match = request.decisions.find((candidate) => candidate.value === decision)
  const response = match?.response
  if (isPermissionResult(response)) {
    return response
  }

  if (decision === "allow") {
    return { behavior: "allow" }
  }
  return { behavior: "deny", message: "Denied by operator." }
}
