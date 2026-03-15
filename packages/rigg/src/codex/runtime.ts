import type { OutputDefinition } from "../compile/schema"
import { validateOutputValue } from "../compile/schema"
import { createStepFailedError } from "../run/error"
import { normalizeError } from "../util/error"
import { stringifyJson } from "../util/json"
import { RIGG_VERSION } from "../version"
import type { CodexProviderEvent } from "./event"
import type { CodexInteractionHandler, CodexInteractionRequest, CodexInteractionResolution } from "./interaction"
import {
  startCodexAppServer,
  assertSupportedCodexVersion,
  isBenignCodexDiagnostic,
  type CodexProcessOptions,
} from "./process"
import { createCodexRpcClient } from "./rpc"
import {
  buildRunPrompt,
  ensureAuthenticatedAccount,
  mapReviewTarget,
  parseApprovalRequest,
  parseCompletedAssistantMessage,
  parseElicitationRequest,
  parseErrorNotification,
  parseItemNotification,
  parseJsonOutput,
  parseMessageDeltaNotification,
  parseReviewItem,
  parseReviewText,
  parseThreadStartResponse,
  parseToolEvent,
  parseTurnCompletedNotification,
  parseTurnStartResponse,
  parseUserInputRequest,
  readPermissionsPayload,
  readTurnIdFromParams,
  type ReviewStartTarget,
  type ReviewThreadTarget,
} from "./protocol"

type CodexRuntimeOptions = CodexProcessOptions

type InitializeParams = {
  capabilities: null
  clientInfo: {
    name: string
    title: string
    version: string
  }
}

type ThreadStartParams = {
  cwd: string
  experimentalRawEvents: boolean
  model: string | null
  persistExtendedHistory: boolean
}

type TurnStartParams = {
  input: Array<{
    text: string
    text_elements: []
    type: "text"
  }>
  model: string | null
  outputSchema: null
  threadId: string
}

type ReviewStartParams = {
  target: ReviewStartTarget
  threadId: string
}

type TurnInterruptParams = {
  threadId: string
  turnId: string
}

type TurnMethod = "review/start" | "turn/start"

type TurnCapture = {
  diagnostics: string[]
  providerEvents: CodexProviderEvent[]
}

type TurnExecution = {
  assistantMessages: string[]
  capture: TurnCapture
  cleanup: () => void
  errorMessage: string | null
  interactionHandler?: CodexInteractionHandler | undefined
  onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
  reject: (error: Error) => void
  resolve: (value: TurnResult) => void
  reviewText: string | null
  threadId: string
  turnId: string
}

type TurnResult = {
  diagnostics: string[]
  errorMessage: string | null
  providerEvents: CodexProviderEvent[]
  reviewText: string | null
  status: string
  text: string
}

export type CodexStepResult = {
  exitCode: number
  providerEvents: CodexProviderEvent[]
  result: unknown
  stderr: string
  stdout: string
  termination: "completed" | "failed" | "interrupted"
}

export type CodexRuntimeSession = {
  close: () => Promise<void>
  interruptTurn: (input: { threadId: string; turnId: string }) => Promise<void>
  review: (options: {
    cwd: string
    interactionHandler?: CodexInteractionHandler | undefined
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    signal?: AbortSignal | undefined
    target: ReviewThreadTarget
  }) => Promise<CodexStepResult>
  run: (options: {
    cwd: string
    interactionHandler?: CodexInteractionHandler | undefined
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    outputSchema?: OutputDefinition | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }) => Promise<CodexStepResult>
}

export async function createCodexRuntimeSession(options: CodexRuntimeOptions): Promise<CodexRuntimeSession> {
  assertSupportedCodexVersion(options)

  const appServer = startCodexAppServer(options)
  const rpc = createCodexRpcClient(appServer)
  const executions = new Map<string, TurnExecution>()
  let closed = false

  const sigintHandler = () => {
    for (const execution of executions.values()) {
      void interruptTurn({ threadId: execution.threadId, turnId: execution.turnId })
    }
  }
  globalThis.process.on("SIGINT", sigintHandler)

  function captureEvent(
    capture: TurnCapture,
    event: CodexProviderEvent,
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined,
  ): Promise<void> | void {
    capture.providerEvents.push(event)
    return onEvent?.(event)
  }

  function appendDiagnostic(line: string): void {
    let singleExecution: TurnExecution | undefined
    for (const execution of executions.values()) {
      execution.capture.diagnostics.push(line)
      singleExecution = execution
    }

    if (executions.size === 1 && singleExecution !== undefined) {
      void captureEvent(
        singleExecution.capture,
        { kind: "diagnostic", message: line, provider: "codex" },
        singleExecution.onEvent,
      )
    }
  }

  function finalizeFailedTurn(turn: TurnResult): CodexStepResult {
    const interrupted = turn.status === "interrupted"
    return {
      exitCode: interrupted ? 130 : 1,
      providerEvents: [...turn.providerEvents],
      result: null,
      stderr: turn.diagnostics.join("\n"),
      stdout: turn.errorMessage ?? turn.text,
      termination: interrupted ? "interrupted" : "failed",
    }
  }

  function failAllTurns(error: Error): void {
    for (const execution of executions.values()) {
      execution.cleanup()
      execution.reject(error)
    }
    executions.clear()
  }

  appServer.child.once("exit", (code, signal) => {
    failAllTurns(new Error(`codex app-server exited unexpectedly (code=${String(code)} signal=${String(signal)})`))
  })
  appServer.stderr.on("line", (line) => {
    if (isBenignCodexDiagnostic(line)) {
      return
    }
    appendDiagnostic(line)
  })

  rpc.start({
    onError: async (error) => {
      failAllTurns(error)
    },
    onNotification: async (message) => {
      await handleNotification(message.method, message.params)
    },
    onRequest: async (message) => {
      await handleRequest(message.id, message.method, message.params)
    },
  })

  const initializeParams: InitializeParams = {
    capabilities: null,
    clientInfo: {
      name: "@tryrigg/rigg",
      title: "Rigg",
      version: RIGG_VERSION,
    },
  }
  await rpc.request("initialize", initializeParams)
  rpc.notify("initialized")
  ensureAuthenticatedAccount(await rpc.request("account/read", { refreshToken: false }))

  async function startThread(options_: {
    capture: TurnCapture
    cwd: string
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
  }): Promise<string> {
    const params: ThreadStartParams = {
      cwd: options_.cwd,
      experimentalRawEvents: false,
      model: options_.model ?? null,
      persistExtendedHistory: false,
    }
    const threadId = parseThreadStartResponse(await rpc.request("thread/start", params))
    await captureEvent(options_.capture, { kind: "thread_started", provider: "codex", threadId }, options_.onEvent)
    return threadId
  }

  async function executeTurn(input: {
    capture: TurnCapture
    interactionHandler?: CodexInteractionHandler | undefined
    method: TurnMethod
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    params: ReviewStartParams | TurnStartParams
    signal?: AbortSignal | undefined
    threadId: string
  }): Promise<TurnResult> {
    const turnId = parseTurnStartResponse(input.method, await rpc.request(input.method, input.params))
    return await new Promise<TurnResult>((resolve, reject) => {
      const execution: TurnExecution = {
        assistantMessages: [],
        capture: input.capture,
        cleanup: () => {},
        errorMessage: null,
        interactionHandler: input.interactionHandler,
        onEvent: input.onEvent,
        reject,
        resolve,
        reviewText: null,
        threadId: input.threadId,
        turnId,
      }

      const abortListener = () => {
        void interruptTurn({ threadId: input.threadId, turnId }).catch((error) => {
          execution.cleanup()
          executions.delete(turnId)
          reject(normalizeError(error))
        })
      }

      execution.cleanup = () => {
        input.signal?.removeEventListener("abort", abortListener)
      }

      executions.set(turnId, execution)
      void captureEvent(
        input.capture,
        { kind: "turn_started", provider: "codex", threadId: input.threadId, turnId },
        input.onEvent,
      )

      if (input.signal?.aborted) {
        abortListener()
        return
      }

      input.signal?.addEventListener("abort", abortListener, { once: true })
    })
  }

  async function run(options_: {
    cwd: string
    interactionHandler?: CodexInteractionHandler | undefined
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    outputSchema?: OutputDefinition | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }): Promise<CodexStepResult> {
    const capture: TurnCapture = { diagnostics: [], providerEvents: [] }
    const threadId = await startThread({
      capture,
      cwd: options_.cwd,
      model: options_.model,
      onEvent: options_.onEvent,
    })

    const prompt = buildRunPrompt(options_.prompt, options_.outputSchema)
    const params: TurnStartParams = {
      input: [{ text: prompt, text_elements: [], type: "text" }],
      model: options_.model ?? null,
      outputSchema: null,
      threadId,
    }
    const turn = await executeTurn({
      capture,
      interactionHandler: options_.interactionHandler,
      method: "turn/start",
      onEvent: options_.onEvent,
      params,
      signal: options_.signal,
      threadId,
    })
    if (turn.status !== "completed") {
      return finalizeFailedTurn(turn)
    }

    if (options_.outputSchema === undefined) {
      return {
        exitCode: 0,
        providerEvents: [...turn.providerEvents],
        result: turn.text,
        stderr: turn.diagnostics.join("\n"),
        stdout: turn.text,
        termination: "completed",
      }
    }

    const parsed = parseJsonOutput(turn.text, "Codex")
    const validationErrors = validateOutputValue(options_.outputSchema, parsed)
    if (validationErrors.length > 0) {
      throw createStepFailedError(new Error(validationErrors.join("; ")))
    }

    return {
      exitCode: 0,
      providerEvents: [...turn.providerEvents],
      result: parsed,
      stderr: turn.diagnostics.join("\n"),
      stdout: typeof parsed === "string" ? parsed : stringifyJson(parsed),
      termination: "completed",
    }
  }

  async function review(options_: {
    cwd: string
    interactionHandler?: CodexInteractionHandler | undefined
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    signal?: AbortSignal | undefined
    target: ReviewThreadTarget
  }): Promise<CodexStepResult> {
    const capture: TurnCapture = { diagnostics: [], providerEvents: [] }
    const threadId = await startThread({
      capture,
      cwd: options_.cwd,
      model: options_.model,
      onEvent: options_.onEvent,
    })

    const params: ReviewStartParams = {
      target: mapReviewTarget(options_.target),
      threadId,
    }
    const turn = await executeTurn({
      capture,
      interactionHandler: options_.interactionHandler,
      method: "review/start",
      onEvent: options_.onEvent,
      params,
      signal: options_.signal,
      threadId,
    })
    if (turn.status !== "completed") {
      return finalizeFailedTurn(turn)
    }

    const reviewResult = parseReviewText(turn.reviewText ?? turn.text)
    return {
      exitCode: 0,
      providerEvents: [...turn.providerEvents],
      result: reviewResult,
      stderr: turn.diagnostics.join("\n"),
      stdout: turn.reviewText ?? turn.text,
      termination: "completed",
    }
  }

  async function interruptTurn(input: { threadId: string; turnId: string }): Promise<void> {
    if (!executions.has(input.turnId)) {
      return
    }
    const params: TurnInterruptParams = {
      threadId: input.threadId,
      turnId: input.turnId,
    }
    await rpc.request("turn/interrupt", params)
  }

  async function close(): Promise<void> {
    if (closed) {
      return
    }
    closed = true
    globalThis.process.off("SIGINT", sigintHandler)
    await rpc.close()
  }

  async function handleRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const requestId = String(id)
    const execution = executionFromParams(params)
    if (execution?.interactionHandler === undefined) {
      throw new Error(`codex app-server requested ${method}, but no interaction handler is configured`)
    }

    if (method === "item/commandExecution/requestApproval") {
      const request = parseApprovalRequest("command_execution", requestId, params)
      const resolution = await execution.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      rpc.respond(id, { decision: resolution.decision })
      return
    }
    if (method === "item/fileChange/requestApproval") {
      const request = parseApprovalRequest("file_change", requestId, params)
      const resolution = await execution.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      rpc.respond(id, { decision: resolution.decision === "accept" ? "accept" : resolution.decision })
      return
    }
    if (method === "item/permissions/requestApproval") {
      const request = parseApprovalRequest("permissions", requestId, params)
      const resolution = await execution.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      rpc.respond(id, {
        permissions: resolution.decision === "accept" ? readPermissionsPayload(params) : {},
        scope: resolution.scope ?? "turn",
      })
      return
    }
    if (method === "item/tool/requestUserInput") {
      const request = parseUserInputRequest(requestId, params)
      const resolution = await execution.interactionHandler(request)
      assertResolutionKind("user_input", resolution)
      rpc.respond(id, { answers: resolution.answers })
      return
    }
    if (method === "mcpServer/elicitation/request") {
      const request = parseElicitationRequest(requestId, params)
      const resolution = await execution.interactionHandler(request)
      assertResolutionKind("elicitation", resolution)
      rpc.respond(id, {
        _meta: resolution._meta ?? null,
        action: resolution.action,
        content: resolution.content ?? null,
      })
      return
    }

    throw new Error(`unsupported codex app-server server request: ${method}`)
  }

  async function handleNotification(method: string, params: unknown): Promise<void> {
    if (method === "thread/started" || method === "turn/started") {
      return
    }

    if (method === "error") {
      const notification = parseErrorNotification(params)
      const execution = executionFromParams(params, false)
      if (execution === undefined) {
        return
      }

      execution.errorMessage = notification.message
      await captureEvent(
        execution.capture,
        {
          kind: "error",
          message: notification.message,
          provider: "codex",
          threadId: notification.threadId,
          turnId: notification.turnId,
        },
        execution.onEvent,
      )
      return
    }

    if (method === "item/agentMessage/delta") {
      const execution = requireExecution(params)
      const notification = parseMessageDeltaNotification(params)
      if (notification.text !== null && notification.text.length > 0) {
        await captureEvent(
          execution.capture,
          {
            itemId: notification.itemId,
            kind: "message_delta",
            provider: "codex",
            text: notification.text,
            threadId: execution.threadId,
            turnId: execution.turnId,
          },
          execution.onEvent,
        )
      }
      return
    }

    if (method === "item/started" || method === "item/completed") {
      const execution = requireExecution(params)
      const { item } = parseItemNotification(params)

      if (method === "item/completed") {
        const assistantMessage = parseCompletedAssistantMessage(item)
        if (assistantMessage !== null) {
          execution.assistantMessages.push(assistantMessage.text)
          await captureEvent(
            execution.capture,
            {
              itemId: assistantMessage.itemId,
              kind: "message_completed",
              provider: "codex",
              text: assistantMessage.text,
              threadId: execution.threadId,
              turnId: execution.turnId,
            },
            execution.onEvent,
          )
          return
        }
      }

      const reviewText = parseReviewItem(item)
      if (reviewText !== null) {
        execution.reviewText = reviewText
        return
      }

      const toolEvent = parseToolEvent(item, {
        itemId: typeof item["id"] === "string" ? item["id"] : null,
        kind: method === "item/started" ? "tool_started" : "tool_completed",
        threadId: execution.threadId,
        turnId: execution.turnId,
      })
      if (toolEvent !== undefined) {
        await captureEvent(execution.capture, toolEvent, execution.onEvent)
      }
      return
    }

    if (method === "turn/completed") {
      const notification = parseTurnCompletedNotification(params)
      const execution = executions.get(notification.turnId)
      if (execution === undefined) {
        throw new Error("received turn/completed without an active turn")
      }
      await captureEvent(
        execution.capture,
        {
          kind: "turn_completed",
          provider: "codex",
          status: notification.status,
          threadId: execution.threadId,
          turnId: execution.turnId,
        },
        execution.onEvent,
      )

      const result: TurnResult = {
        diagnostics: execution.capture.diagnostics,
        errorMessage: notification.errorMessage ?? execution.errorMessage,
        providerEvents: execution.capture.providerEvents,
        reviewText: execution.reviewText,
        status: notification.status,
        text: execution.assistantMessages.join("\n"),
      }

      execution.cleanup()
      executions.delete(notification.turnId)
      execution.resolve(result)
      return
    }

    return
  }

  function executionFromParams(params: unknown, allowSingleFallback = true): TurnExecution | undefined {
    const turnId = readTurnIdFromParams(params)
    if (turnId !== undefined) {
      return executions.get(turnId)
    }
    if (allowSingleFallback && executions.size === 1) {
      const firstExecution = executions.values().next()
      return firstExecution.done ? undefined : firstExecution.value
    }
    return undefined
  }

  function requireExecution(params: unknown): TurnExecution {
    const execution = executionFromParams(params)
    if (execution === undefined) {
      throw new Error("codex app-server referenced an unknown turn")
    }
    return execution
  }

  return {
    close,
    interruptTurn,
    review,
    run,
  }
}

function assertResolutionKind<TKind extends CodexInteractionRequest["kind"]>(
  expected: TKind,
  resolution: CodexInteractionResolution,
): asserts resolution is Extract<CodexInteractionResolution, { kind: TKind }> {
  if (resolution.kind !== expected) {
    throw new Error(`interaction handler returned ${resolution.kind} for ${expected}`)
  }
}
