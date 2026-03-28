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
import {
  approvalResponse,
  createApprovalRequest,
  createElicitationRequest,
  createElicitationResult,
  createUserInputRequest,
} from "./input"
import {
  normalizeProviderError,
  readAssistantMessage,
  readAuthMessages,
  readResultStatus,
  readSessionStart,
  readStreamDelta,
  readToolProgress,
  readToolSummary,
} from "./msg"
import { assertVersion, resolveBinaryPath, type ClaudeProcessOptions } from "./proc"
import { onAbort } from "../../util/abort"
import { createAbortError, isAbortError, normalizeError } from "../../util/error"
import type {
  ApprovalRequest,
  InteractionRequest,
  InteractionResolution,
  InteractionHandler,
} from "../../session/interaction"
import type { ActionStepOutput } from "../../session/step"

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
  const started = readSessionStart(message)
  if (started !== null) {
    turn.sessionId = started.sessionId
    await emit(turn, {
      cwd: started.cwd,
      kind: "session_started",
      model: started.model,
      provider: "claude",
      sessionId: started.sessionId,
    })
    return stream
  }

  const delta = readStreamDelta(message, stream?.id ?? null)
  if (delta !== null) {
    const next = appendStreamMessage(stream, messageText, delta)
    streamedText.push(delta.text)
    await emit(turn, {
      kind: "message_delta",
      messageId: next.id,
      provider: "claude",
      sessionId: message.session_id,
      text: delta.text,
    })
    return next
  }

  const assistant = readAssistantMessage(message, stream?.id ?? null)
  if (assistant !== null) {
    let nextStream: StreamMessage | null = stream
    if (assistant.text.length > 0) {
      messageText.set(assistant.messageId, assistant.text)
      await emit(turn, {
        kind: "message_completed",
        messageId: assistant.messageId,
        provider: "claude",
        sessionId: message.session_id,
        text: assistant.text,
      })
      nextStream = null
    }

    for (const tool of assistant.tools) {
      pendingTools.set(tool.id, { detail: tool.detail, tool: tool.name })
      await emit(turn, {
        detail: tool.detail,
        kind: "tool_started",
        provider: "claude",
        sessionId: message.session_id,
        tool: tool.name,
      })
    }

    if (assistant.error !== null) {
      turn.capture.diagnostics.push(assistant.error)
      await emit(turn, {
        kind: "error",
        message: assistant.error,
        provider: "claude",
        sessionId: message.session_id,
      })
    }
    return nextStream
  }

  const progress = readToolProgress(message)
  if (progress !== null) {
    if (pendingTools.has(progress.id)) {
      return stream
    }
    pendingTools.set(progress.id, { tool: progress.name })
    await emit(turn, {
      kind: "tool_started",
      provider: "claude",
      sessionId: message.session_id,
      tool: progress.name,
    })
    return stream
  }

  const summary = readToolSummary(message)
  if (summary !== null) {
    for (const toolUseId of summary.ids) {
      const tool = pendingTools.get(toolUseId)
      pendingTools.delete(toolUseId)
      await emit(turn, {
        detail: summary.detail,
        kind: "tool_completed",
        provider: "claude",
        sessionId: message.session_id,
        tool: tool?.tool ?? "tool",
      })
    }
    return stream
  }

  const auth = readAuthMessages(message)
  if (auth.length > 0) {
    for (const item of auth) {
      turn.capture.diagnostics.push(item.message)
      await emit(turn, {
        kind: item.kind,
        message: item.message,
        provider: "claude",
        sessionId: message.session_id,
      })
    }
    return stream
  }

  const status = readResultStatus(message)
  if (status !== null) {
    await emit(turn, {
      kind: "session_completed",
      provider: "claude",
      sessionId: message.session_id,
      status,
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
    input: unknown
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
    return createElicitationResult(resolution, prompt)
  }

  const elicitationRequest = createElicitationRequest(sessionId, request)
  signal.throwIfAborted()
  const resolution = await raceInteraction(signal, () => interactionHandler(elicitationRequest))
  assertResolutionKind("elicitation", resolution)
  return {
    action: resolution.action,
    content: resolution.content,
  }
}

function joinDiagnostics(diagnostics: string[], error: string | null): string {
  const lines = [...diagnostics]
  if (error !== null && !lines.includes(error)) {
    lines.push(error)
  }
  return lines.join("\n")
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
  input: { messageId: string; text: string },
): StreamMessage {
  const text = `${stream?.text ?? messageText.get(input.messageId) ?? ""}${input.text}`
  if (stream !== null && stream.id !== input.messageId) {
    messageText.delete(stream.id)
  }
  messageText.set(input.messageId, text)
  return { id: input.messageId, text }
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
