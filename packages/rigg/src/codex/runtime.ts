import type { OutputDefinition } from "../compile/schema"
import { validateOutputValue } from "../compile/schema"
import { createStepFailedError } from "../run/error"
import { isAbortError, normalizeError } from "../util/error"
import { stringifyJson } from "../util/json"
import { RIGG_VERSION } from "../version"
import type { CodexProviderEvent } from "./event"
import {
  findApprovalDecisionByIntent,
  type CodexInteractionHandler,
  type CodexInteractionRequest,
  type CodexInteractionResolution,
} from "./interaction"
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
import {
  appendAssistantMessageDelta,
  completeAssistantMessage,
  createAssistantTranscript,
  renderAssistantTranscript,
  type AssistantTranscript,
} from "./transcript"

type CodexRuntimeOptions = CodexProcessOptions & {
  signal?: AbortSignal | undefined
}

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
  assistantTranscript: AssistantTranscript
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

type DeferredTurnMessage =
  | { kind: "notification"; method: string; params: unknown }
  | { id: string | number; kind: "request"; method: string; params: unknown }

type ExecutionLookup = { execution: TurnExecution; kind: "found" } | { kind: "deferred" } | { kind: "missing" }

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
  const deferredTurnMessages = new Map<string, DeferredTurnMessage[]>()
  const executions = new Map<string, TurnExecution>()
  let closed = false
  let pendingTurnStarts = 0

  function captureEvent(
    capture: TurnCapture,
    event: CodexProviderEvent,
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined,
  ): Promise<void> | void {
    capture.providerEvents.push(event)
    return onEvent?.(event)
  }

  function appendDiagnostic(line: string): void {
    if (pendingTurnStarts !== 0 || deferredTurnMessages.size !== 0 || executions.size !== 1) {
      return
    }

    const singleExecution = executions.values().next()
    if (singleExecution.done) {
      return
    }

    singleExecution.value.capture.diagnostics.push(line)
    void captureEvent(
      singleExecution.value.capture,
      {
        kind: "diagnostic",
        message: line,
        provider: "codex",
        threadId: singleExecution.value.threadId,
        turnId: singleExecution.value.turnId,
      },
      singleExecution.value.onEvent,
    )
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

  function interruptedStepResult(capture: TurnCapture): CodexStepResult {
    return {
      exitCode: 130,
      providerEvents: [...capture.providerEvents],
      result: null,
      stderr: capture.diagnostics.join("\n"),
      stdout: "",
      termination: "interrupted",
    }
  }

  function failAllTurns(error: Error): void {
    for (const execution of executions.values()) {
      execution.cleanup()
      execution.reject(error)
    }
    executions.clear()
  }

  function trackExecution(execution: TurnExecution): void {
    executions.set(execution.turnId, execution)
  }

  function untrackExecution(turnId: string): TurnExecution | undefined {
    const execution = executions.get(turnId)
    if (execution === undefined) {
      return undefined
    }

    execution.cleanup()
    executions.delete(turnId)
    return execution
  }

  void appServer.exited.then((exit) => {
    if (exit.expected) {
      return
    }
    failAllTurns(
      new Error(`codex app-server exited unexpectedly (code=${String(exit.code)} signal=${String(exit.signal)})`),
    )
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
  try {
    await rpc.request("initialize", initializeParams, { signal: options.signal })
    rpc.notify("initialized")
    ensureAuthenticatedAccount(await rpc.request("account/read", { refreshToken: false }, { signal: options.signal }))
  } catch (error) {
    const bootstrapError = normalizeError(error)
    try {
      await close()
    } catch {
      // Prefer surfacing the bootstrap failure; close() is best-effort here.
    }
    throw bootstrapError
  }

  async function startThread(options_: {
    capture: TurnCapture
    cwd: string
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    signal?: AbortSignal | undefined
  }): Promise<string> {
    const params: ThreadStartParams = {
      cwd: options_.cwd,
      experimentalRawEvents: false,
      model: options_.model ?? null,
      persistExtendedHistory: false,
    }
    const threadId = parseThreadStartResponse(await rpc.request("thread/start", params, { signal: options_.signal }))
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
    const turnPromise = createPromiseKit<TurnResult>()

    let turnId: string | undefined
    pendingTurnStarts += 1
    try {
      turnId = parseTurnStartResponse(
        input.method,
        await rpc.request(input.method, input.params, { signal: input.signal }),
      )
      const activeTurnId = turnId
      const execution: TurnExecution = {
        assistantTranscript: createAssistantTranscript(),
        capture: input.capture,
        cleanup: () => {},
        errorMessage: null,
        interactionHandler: input.interactionHandler,
        onEvent: input.onEvent,
        reject: turnPromise.reject,
        resolve: turnPromise.resolve,
        reviewText: null,
        threadId: input.threadId,
        turnId: activeTurnId,
      }

      const abortListener = () => {
        void interruptTurn({ threadId: input.threadId, turnId: activeTurnId }).catch((error) => {
          untrackExecution(activeTurnId)
          turnPromise.reject(normalizeError(error))
        })
      }

      execution.cleanup = () => {
        input.signal?.removeEventListener("abort", abortListener)
      }

      trackExecution(execution)
      void captureEvent(
        input.capture,
        { kind: "turn_started", provider: "codex", threadId: input.threadId, turnId: activeTurnId },
        input.onEvent,
      )

      if (input.signal?.aborted) {
        abortListener()
      } else {
        input.signal?.addEventListener("abort", abortListener, { once: true })
      }
    } catch (error) {
      turnPromise.reject(normalizeError(error))
    } finally {
      pendingTurnStarts -= 1
    }

    if (turnId !== undefined) {
      await flushDeferredTurnMessages(turnId)
    }

    return await turnPromise.promise
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
    let threadId: string
    try {
      threadId = await startThread({
        capture,
        cwd: options_.cwd,
        model: options_.model,
        onEvent: options_.onEvent,
        signal: options_.signal,
      })
    } catch (error) {
      if (options_.signal?.aborted && isAbortError(error)) {
        await close()
        return interruptedStepResult(capture)
      }
      throw normalizeError(error)
    }

    const prompt = buildRunPrompt(options_.prompt, options_.outputSchema)
    const params: TurnStartParams = {
      input: [{ text: prompt, text_elements: [], type: "text" }],
      model: options_.model ?? null,
      outputSchema: null,
      threadId,
    }
    let turn: TurnResult
    try {
      turn = await executeTurn({
        capture,
        interactionHandler: options_.interactionHandler,
        method: "turn/start",
        onEvent: options_.onEvent,
        params,
        signal: options_.signal,
        threadId,
      })
    } catch (error) {
      if (options_.signal?.aborted && isAbortError(error)) {
        await close()
        return interruptedStepResult(capture)
      }
      throw normalizeError(error)
    }
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
    let threadId: string
    try {
      threadId = await startThread({
        capture,
        cwd: options_.cwd,
        model: options_.model,
        onEvent: options_.onEvent,
        signal: options_.signal,
      })
    } catch (error) {
      if (options_.signal?.aborted && isAbortError(error)) {
        await close()
        return interruptedStepResult(capture)
      }
      throw normalizeError(error)
    }

    const params: ReviewStartParams = {
      target: mapReviewTarget(options_.target),
      threadId,
    }
    let turn: TurnResult
    try {
      turn = await executeTurn({
        capture,
        interactionHandler: options_.interactionHandler,
        method: "review/start",
        onEvent: options_.onEvent,
        params,
        signal: options_.signal,
        threadId,
      })
    } catch (error) {
      if (options_.signal?.aborted && isAbortError(error)) {
        await close()
        return interruptedStepResult(capture)
      }
      throw normalizeError(error)
    }
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
    deferredTurnMessages.clear()
    failAllTurns(new Error("codex runtime session closed"))
    await rpc.close()
  }

  async function handleRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const requestId = String(id)
    const executionLookup = lookupExecution({ id, kind: "request", method, params })
    if (executionLookup.kind === "deferred") {
      return
    }
    if (executionLookup.kind === "missing") {
      throw new Error("codex app-server referenced an unknown turn")
    }

    const { execution } = executionLookup
    if (execution.interactionHandler === undefined) {
      throw new Error(`codex app-server requested ${method}, but no interaction handler is configured`)
    }

    if (method === "item/commandExecution/requestApproval") {
      const request = parseApprovalRequest("command_execution", requestId, params)
      const resolution = await execution.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      assertApprovalDecision(request, resolution.decision)
      rpc.respond(id, { decision: resolution.decision })
      return
    }
    if (method === "item/fileChange/requestApproval") {
      const request = parseApprovalRequest("file_change", requestId, params)
      const resolution = await execution.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      assertApprovalDecision(request, resolution.decision)
      rpc.respond(id, { decision: resolution.decision })
      return
    }
    if (method === "item/permissions/requestApproval") {
      const request = parseApprovalRequest("permissions", requestId, params)
      const resolution = await execution.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      assertApprovalDecision(request, resolution.decision)
      const approvedDecision = findApprovalDecisionByIntent(request, "approve")
      rpc.respond(id, {
        permissions: approvedDecision?.value === resolution.decision ? readPermissionsPayload(params) : {},
        scope: "turn",
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
      const executionLookup = lookupExecution({ kind: "notification", method, params })
      if (executionLookup.kind === "deferred") {
        return
      }
      if (executionLookup.kind === "missing") {
        throw new Error("codex app-server referenced an unknown turn")
      }

      const { execution } = executionLookup
      const notification = parseMessageDeltaNotification(params)
      if (notification.text !== null && notification.text.length > 0) {
        appendAssistantMessageDelta(execution.assistantTranscript, {
          itemId: notification.itemId,
          text: notification.text,
        })
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
      const executionLookup = lookupExecution({ kind: "notification", method, params })
      if (executionLookup.kind === "deferred") {
        return
      }
      if (executionLookup.kind === "missing") {
        throw new Error("codex app-server referenced an unknown turn")
      }

      const { execution } = executionLookup
      const { item } = parseItemNotification(params)

      if (method === "item/completed") {
        const assistantMessage = parseCompletedAssistantMessage(item)
        if (assistantMessage !== null) {
          const text = completeAssistantMessage(execution.assistantTranscript, assistantMessage)
          await captureEvent(
            execution.capture,
            {
              itemId: assistantMessage.itemId,
              kind: "message_completed",
              provider: "codex",
              text,
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
        if (deferTurnMessage({ kind: "notification", method, params })) {
          return
        }
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
        text: renderAssistantTranscript(execution.assistantTranscript),
      }

      untrackExecution(notification.turnId)
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

  function lookupExecution(message: DeferredTurnMessage, allowSingleFallback = true): ExecutionLookup {
    const execution = executionFromParams(message.params, allowSingleFallback)
    if (execution !== undefined) {
      return { execution, kind: "found" }
    }
    if (deferTurnMessage(message)) {
      return { kind: "deferred" }
    }
    return { kind: "missing" }
  }

  function deferTurnMessage(message: DeferredTurnMessage): boolean {
    const turnId = readDeferredTurnId(message)
    if (turnId === undefined) {
      return false
    }
    if (pendingTurnStarts === 0 && !deferredTurnMessages.has(turnId)) {
      return false
    }

    const queued = deferredTurnMessages.get(turnId)
    if (queued === undefined) {
      deferredTurnMessages.set(turnId, [message])
      return true
    }

    queued.push(message)
    return true
  }

  function readDeferredTurnId(message: DeferredTurnMessage): string | undefined {
    const turnId = readTurnIdFromParams(message.params)
    if (turnId !== undefined) {
      return turnId
    }
    if (message.kind === "notification" && message.method === "turn/completed") {
      try {
        return parseTurnCompletedNotification(message.params).turnId
      } catch {
        return undefined
      }
    }
    return undefined
  }

  async function flushDeferredTurnMessages(turnId: string): Promise<void> {
    const queued = deferredTurnMessages.get(turnId)
    if (queued === undefined) {
      return
    }

    deferredTurnMessages.delete(turnId)
    for (const message of queued) {
      if (message.kind === "notification") {
        await handleNotification(message.method, message.params)
        continue
      }

      await handleRequest(message.id, message.method, message.params)
    }
  }

  return {
    close,
    interruptTurn,
    review,
    run,
  }
}

function createPromiseKit<T>(): {
  promise: Promise<T>
  reject: (error: Error) => void
  resolve: (value: T) => void
} {
  let reject: ((error: Error) => void) | undefined
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = (error) => innerReject(error)
  })

  if (resolve === undefined || reject === undefined) {
    throw new Error("failed to initialize promise kit")
  }

  return { promise, reject, resolve }
}

function assertResolutionKind<TKind extends CodexInteractionRequest["kind"]>(
  expected: TKind,
  resolution: CodexInteractionResolution,
): asserts resolution is Extract<CodexInteractionResolution, { kind: TKind }> {
  if (resolution.kind !== expected) {
    throw new Error(`interaction handler returned ${resolution.kind} for ${expected}`)
  }
}

function assertApprovalDecision(
  request: Extract<CodexInteractionRequest, { kind: "approval" }>,
  decision: string,
): void {
  if (request.decisions.some((candidate) => candidate.value === decision)) {
    return
  }

  throw new Error(`interaction handler returned invalid approval decision: ${decision}`)
}
