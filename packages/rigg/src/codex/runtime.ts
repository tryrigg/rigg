import { isAbortError, normalizeError } from "../util/error"
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
  ensureAuthenticatedAccount,
  mapReviewTarget,
  parseApprovalRequest,
  parseCollaborationModeListResponse,
  parseCompletedAssistantMessage,
  parseElicitationRequest,
  parseErrorNotification,
  parseItemNotification,
  parseMessageDeltaNotification,
  parseReviewItem,
  parseReviewText,
  parseThreadStartResponse,
  parseToolEvent,
  parseTurnCompletedNotification,
  parseTurnStartResponse,
  parseUserInputRequest,
  readPermissionsPayload,
  readTurnCompletedNotificationTurnId,
  readTurnIdFromParams,
  type CollaborationModeKind,
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

type CodexRuntimeOptions = CodexProcessOptions & { signal?: AbortSignal | undefined }

type InitializeParams = {
  capabilities: {
    experimentalApi: boolean
  }
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

type CollaborationMode = {
  mode: CollaborationModeKind
  settings: {
    developer_instructions: null
    model: string
    reasoning_effort: "high" | "low" | "medium" | "minimal" | "xhigh" | null
  }
}

type CollaborationModePreset = {
  mode: CollaborationModeKind
  settings: {
    model: string | null
    reasoning_effort: "high" | "low" | "medium" | "minimal" | "xhigh" | null
  }
}

type TurnStartParams = {
  collaborationMode?: CollaborationMode
  input: Array<{
    text: string
    text_elements: []
    type: "text"
  }>
  model?: string | null
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
  interrupting: boolean
  onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
  reject: (error: Error) => void
  resolve: (value: TurnResult) => void
  reviewText: string | null
  settled: boolean
  threadId: string
  turnId: string
}

type DeferredTurnMessage =
  | { kind: "notification"; method: string; params: unknown }
  | { id: string | number; kind: "request"; method: string; params: unknown }

type ExecutionLookup =
  | { execution: TurnExecution; kind: "found" }
  | { kind: "deferred" }
  | { kind: "missing" }
  | { kind: "stale" }

type TurnResult = {
  diagnostics: string[]
  errorMessage: string | null
  providerEvents: CodexProviderEvent[]
  reviewText: string | null
  status: string
  text: string
}

type RuntimeRequestMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request"

type RuntimeNotificationMethod =
  | "error"
  | "item/agentMessage/delta"
  | "item/completed"
  | "item/started"
  | "thread/started"
  | "turn/completed"
  | "turn/started"

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
    collaborationMode?: CollaborationModeKind | undefined
    cwd: string
    interactionHandler?: CodexInteractionHandler | undefined
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }) => Promise<CodexStepResult>
}

export async function createCodexRuntimeSession(options: CodexRuntimeOptions): Promise<CodexRuntimeSession> {
  const INTERRUPT_REQUEST_TIMEOUT_MS = 1_000
  const INTERRUPT_TIMEOUT_REASON = "rigg interrupt timeout"

  assertSupportedCodexVersion(options)

  const appServer = startCodexAppServer(options)
  const rpc = createCodexRpcClient(appServer)
  const deferredTurnMessages = new Map<string, DeferredTurnMessage[]>()
  const executions = new Map<string, TurnExecution>()
  const staleTurnIds = new Set<string>()
  const collaborationModesByKind = new Map<CollaborationModeKind, CollaborationModePreset>()
  let collaborationModesPromise: Promise<Map<CollaborationModeKind, CollaborationModePreset>> | undefined
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
      rejectExecution(execution, error)
    }
  }

  function trackExecution(execution: TurnExecution): void {
    executions.set(execution.turnId, execution)
  }

  function settleExecution(
    execution: TurnExecution,
    result: TurnResult,
    options_: { tombstone?: boolean } = {},
  ): boolean {
    if (execution.settled) {
      return false
    }

    execution.settled = true
    execution.cleanup()
    executions.delete(execution.turnId)
    if (options_.tombstone === true) {
      staleTurnIds.add(execution.turnId)
    }
    execution.resolve(result)
    return true
  }

  function rejectExecution(execution: TurnExecution, error: Error): boolean {
    if (execution.settled) {
      return false
    }

    execution.settled = true
    execution.cleanup()
    executions.delete(execution.turnId)
    execution.reject(error)
    return true
  }

  async function emitInterruptedTurnEvent(execution: TurnExecution): Promise<void> {
    await captureEvent(
      execution.capture,
      {
        kind: "turn_completed",
        provider: "codex",
        status: "interrupted",
        threadId: execution.threadId,
        turnId: execution.turnId,
      },
      execution.onEvent,
    )
  }

  function buildTurnResult(execution: TurnExecution, status: string): TurnResult {
    return {
      diagnostics: execution.capture.diagnostics,
      errorMessage: execution.errorMessage,
      providerEvents: execution.capture.providerEvents,
      reviewText: execution.reviewText,
      status,
      text: renderAssistantTranscript(execution.assistantTranscript),
    }
  }

  async function completeInterruptedExecution(execution: TurnExecution): Promise<void> {
    if (execution.settled) {
      return
    }

    try {
      await emitInterruptedTurnEvent(execution)
    } catch (error) {
      rejectExecution(execution, normalizeError(error))
      return
    }
    settleExecution(execution, buildTurnResult(execution, "interrupted"), { tombstone: true })
  }

  async function interruptExecution(execution: TurnExecution): Promise<void> {
    if (execution.settled || execution.interrupting) {
      return
    }

    execution.interrupting = true
    const timeoutController = new AbortController()
    const timeout = setTimeout(() => {
      timeoutController.abort(INTERRUPT_TIMEOUT_REASON)
    }, INTERRUPT_REQUEST_TIMEOUT_MS)

    try {
      await rpc.request(
        "turn/interrupt",
        {
          threadId: execution.threadId,
          turnId: execution.turnId,
        } satisfies TurnInterruptParams,
        { signal: timeoutController.signal },
      )
    } catch (error) {
      if (!timeoutController.signal.aborted || timeoutController.signal.reason !== INTERRUPT_TIMEOUT_REASON) {
        rejectExecution(execution, normalizeError(error))
        return
      }
    } finally {
      clearTimeout(timeout)
    }

    await completeInterruptedExecution(execution)
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
    capabilities: {
      experimentalApi: true,
    },
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
    } catch (closeError) {
      throw new Error("failed to close codex runtime session after bootstrap failure", {
        cause: new AggregateError([bootstrapError, normalizeError(closeError)]),
      })
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

  async function loadCollaborationModes(
    signal?: AbortSignal | undefined,
  ): Promise<Map<CollaborationModeKind, CollaborationModePreset>> {
    if (collaborationModesPromise !== undefined) {
      return await collaborationModesPromise
    }

    collaborationModesPromise = (async () => {
      const response = await rpc.request("collaborationMode/list", {}, { signal })
      const masks = parseCollaborationModeListResponse(response)
      const modes = new Map<CollaborationModeKind, CollaborationModePreset>()

      for (const mask of masks) {
        if (mask.mode === null) {
          continue
        }

        modes.set(mask.mode, {
          mode: mask.mode,
          settings: {
            model: mask.model,
            reasoning_effort: mask.reasoning_effort,
          },
        })
      }

      if (modes.size === 0) {
        throw new Error("codex app-server did not return any usable collaboration modes")
      }

      for (const [kind, mode] of modes) {
        collaborationModesByKind.set(kind, mode)
      }
      return modes
    })()

    try {
      return await collaborationModesPromise
    } catch (error) {
      collaborationModesPromise = undefined
      throw error
    }
  }

  async function resolveCollaborationMode(
    kind: CollaborationModeKind,
    modelOverride: string | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<CollaborationMode> {
    const preset = collaborationModesByKind.get(kind) ?? (await loadCollaborationModes(signal)).get(kind)
    if (preset === undefined) {
      throw new Error(`codex app-server does not expose collaboration mode \`${kind}\``)
    }
    const model = modelOverride ?? preset.settings.model
    if (model === null) {
      throw new Error(
        `codex app-server collaboration mode \`${kind}\` did not include a default model; specify a model explicitly`,
      )
    }

    return {
      mode: kind,
      settings: {
        developer_instructions: null,
        model,
        reasoning_effort: preset.settings.reasoning_effort,
      },
    }
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
        interrupting: false,
        onEvent: input.onEvent,
        reject: turnPromise.reject,
        resolve: turnPromise.resolve,
        reviewText: null,
        settled: false,
        threadId: input.threadId,
        turnId: activeTurnId,
      }

      const abortListener = () => {
        void interruptExecution(execution)
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

  async function executeThreadTurn(input: {
    collaborationMode?: CollaborationModeKind | undefined
    cwd: string
    finalizeCompletedTurn: (turn: TurnResult) => CodexStepResult
    interactionHandler?: CodexInteractionHandler | undefined
    method: TurnMethod
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    signal?: AbortSignal | undefined
    startThreadModel?: string | undefined
    turnParams: (threadId: string) => Promise<ReviewStartParams | TurnStartParams>
  }): Promise<CodexStepResult> {
    const capture: TurnCapture = { diagnostics: [], providerEvents: [] }
    let threadId: string
    try {
      threadId = await startThread({
        capture,
        cwd: input.cwd,
        model: input.startThreadModel,
        onEvent: input.onEvent,
        signal: input.signal,
      })
    } catch (error) {
      if (input.signal?.aborted && isAbortError(error)) {
        await close()
        return interruptedStepResult(capture)
      }
      throw normalizeError(error)
    }

    let turn: TurnResult
    try {
      const params = await input.turnParams(threadId)
      turn = await executeTurn({
        capture,
        interactionHandler: input.interactionHandler,
        method: input.method,
        onEvent: input.onEvent,
        params,
        signal: input.signal,
        threadId,
      })
    } catch (error) {
      if (input.signal?.aborted && isAbortError(error)) {
        await close()
        return interruptedStepResult(capture)
      }
      throw normalizeError(error)
    }
    if (turn.status !== "completed") {
      return finalizeFailedTurn(turn)
    }

    return input.finalizeCompletedTurn(turn)
  }

  async function run(options_: {
    collaborationMode?: CollaborationModeKind | undefined
    cwd: string
    interactionHandler?: CodexInteractionHandler | undefined
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }): Promise<CodexStepResult> {
    return await executeThreadTurn({
      collaborationMode: options_.collaborationMode,
      cwd: options_.cwd,
      finalizeCompletedTurn: (turn) => ({
        exitCode: 0,
        providerEvents: [...turn.providerEvents],
        result: turn.text,
        stderr: turn.diagnostics.join("\n"),
        stdout: turn.text,
        termination: "completed",
      }),
      interactionHandler: options_.interactionHandler,
      method: "turn/start",
      model: options_.model,
      onEvent: options_.onEvent,
      signal: options_.signal,
      startThreadModel: options_.collaborationMode === undefined ? options_.model : undefined,
      turnParams: async (threadId) => ({
        ...(options_.collaborationMode === undefined
          ? { model: options_.model ?? null }
          : {
              collaborationMode: await resolveCollaborationMode(
                options_.collaborationMode,
                options_.model,
                options_.signal,
              ),
            }),
        input: [{ text: options_.prompt, text_elements: [], type: "text" }],
        threadId,
      }),
    })
  }

  async function review(options_: {
    cwd: string
    interactionHandler?: CodexInteractionHandler | undefined
    model?: string | undefined
    onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
    signal?: AbortSignal | undefined
    target: ReviewThreadTarget
  }): Promise<CodexStepResult> {
    return await executeThreadTurn({
      cwd: options_.cwd,
      finalizeCompletedTurn: (turn) => ({
        exitCode: 0,
        providerEvents: [...turn.providerEvents],
        result: parseReviewText(turn.reviewText ?? turn.text),
        stderr: turn.diagnostics.join("\n"),
        stdout: turn.reviewText ?? turn.text,
        termination: "completed",
      }),
      interactionHandler: options_.interactionHandler,
      method: "review/start",
      model: options_.model,
      onEvent: options_.onEvent,
      signal: options_.signal,
      startThreadModel: options_.model,
      turnParams: async (threadId) => ({
        target: mapReviewTarget(options_.target),
        threadId,
      }),
    })
  }

  async function interruptTurn(input: { threadId: string; turnId: string }): Promise<void> {
    const execution = executions.get(input.turnId)
    if (execution === undefined) {
      return
    }

    await interruptExecution(execution)
  }

  async function close(): Promise<void> {
    if (closed) {
      return
    }
    closed = true
    deferredTurnMessages.clear()
    staleTurnIds.clear()
    failAllTurns(new Error("codex runtime session closed"))
    await rpc.close()
  }

  async function handleApprovalRequest(
    execution: TurnExecution,
    input: {
      id: string | number
      params: unknown
      requestId: string
      requestKind: "command_execution" | "file_change" | "permissions"
    },
  ): Promise<void> {
    if (execution.interactionHandler === undefined) {
      throw new Error("codex app-server requested approval, but no interaction handler is configured")
    }

    const request = parseApprovalRequest(input.requestKind, input.requestId, input.params)
    const resolution = await execution.interactionHandler(request)
    assertResolutionKind("approval", resolution)
    assertApprovalDecision(request, resolution.decision)

    if (input.requestKind === "permissions") {
      const approvedDecision = findApprovalDecisionByIntent(request, "approve")
      rpc.respond(input.id, {
        permissions: approvedDecision?.value === resolution.decision ? readPermissionsPayload(input.params) : {},
        scope: "turn",
      })
      return
    }

    rpc.respond(input.id, { decision: resolution.decision })
  }

  async function handleUserInputRequest(
    execution: TurnExecution,
    input: { id: string | number; params: unknown; requestId: string },
  ): Promise<void> {
    if (execution.interactionHandler === undefined) {
      throw new Error("codex app-server requested user input, but no interaction handler is configured")
    }

    const request = parseUserInputRequest(input.requestId, input.params)
    const resolution = await execution.interactionHandler(request)
    assertResolutionKind("user_input", resolution)
    rpc.respond(input.id, { answers: resolution.answers })
  }

  async function handleElicitationRequest(
    execution: TurnExecution,
    input: { id: string | number; params: unknown; requestId: string },
  ): Promise<void> {
    if (execution.interactionHandler === undefined) {
      throw new Error("codex app-server requested elicitation, but no interaction handler is configured")
    }

    const request = parseElicitationRequest(input.requestId, input.params)
    const resolution = await execution.interactionHandler(request)
    assertResolutionKind("elicitation", resolution)
    rpc.respond(input.id, {
      _meta: resolution._meta ?? null,
      action: resolution.action,
      content: resolution.content ?? null,
    })
  }

  const requestHandlers: Record<
    RuntimeRequestMethod,
    (execution: TurnExecution, input: { id: string | number; params: unknown; requestId: string }) => Promise<void>
  > = {
    "item/commandExecution/requestApproval": async (execution, input) => {
      await handleApprovalRequest(execution, { ...input, requestKind: "command_execution" })
    },
    "item/fileChange/requestApproval": async (execution, input) => {
      await handleApprovalRequest(execution, { ...input, requestKind: "file_change" })
    },
    "item/permissions/requestApproval": async (execution, input) => {
      await handleApprovalRequest(execution, { ...input, requestKind: "permissions" })
    },
    "item/tool/requestUserInput": handleUserInputRequest,
    "mcpServer/elicitation/request": handleElicitationRequest,
  }

  async function handleErrorNotification(params: unknown): Promise<void> {
    if (isStaleTurnMessage({ kind: "notification", method: "error", params })) {
      return
    }

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
  }

  async function handleMessageDeltaNotification(params: unknown): Promise<void> {
    const executionLookup = lookupExecution({ kind: "notification", method: "item/agentMessage/delta", params })
    if (executionLookup.kind === "deferred" || executionLookup.kind === "stale") {
      return
    }
    if (executionLookup.kind === "missing") {
      throw new Error("codex app-server referenced an unknown turn")
    }

    const { execution } = executionLookup
    const notification = parseMessageDeltaNotification(params)
    if (notification.text === null || notification.text.length === 0) {
      return
    }

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

  async function handleItemNotification(method: "item/started" | "item/completed", params: unknown): Promise<void> {
    const executionLookup = lookupExecution({ kind: "notification", method, params })
    if (executionLookup.kind === "deferred" || executionLookup.kind === "stale") {
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
  }

  async function handleTurnCompletedNotification(params: unknown): Promise<void> {
    if (isStaleTurnMessage({ kind: "notification", method: "turn/completed", params })) {
      return
    }

    const notification = parseTurnCompletedNotification(params)
    const execution = executions.get(notification.turnId)
    if (execution === undefined) {
      if (deferTurnMessage({ kind: "notification", method: "turn/completed", params })) {
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

    execution.errorMessage = notification.errorMessage ?? execution.errorMessage
    settleExecution(execution, buildTurnResult(execution, notification.status))
  }

  const notificationHandlers: Record<RuntimeNotificationMethod, (params: unknown) => Promise<void>> = {
    error: handleErrorNotification,
    "item/agentMessage/delta": handleMessageDeltaNotification,
    "item/completed": async (params) => {
      await handleItemNotification("item/completed", params)
    },
    "item/started": async (params) => {
      await handleItemNotification("item/started", params)
    },
    "thread/started": async () => {},
    "turn/completed": handleTurnCompletedNotification,
    "turn/started": async () => {},
  }

  async function handleRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const requestId = String(id)
    const executionLookup = lookupExecution({ id, kind: "request", method, params })
    if (executionLookup.kind === "deferred") {
      return
    }
    if (executionLookup.kind === "stale") {
      return
    }
    if (executionLookup.kind === "missing") {
      throw new Error("codex app-server referenced an unknown turn")
    }

    const { execution } = executionLookup
    const handler = requestHandlers[method as RuntimeRequestMethod]
    if (handler !== undefined) {
      await handler(execution, { id, params, requestId })
      return
    }

    throw new Error(`unsupported codex app-server server request: ${method}`)
  }

  async function handleNotification(method: string, params: unknown): Promise<void> {
    const handler = notificationHandlers[method as RuntimeNotificationMethod]
    if (handler !== undefined) {
      await handler(params)
    }
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
    if (isStaleTurnMessage(message)) {
      return { kind: "stale" }
    }

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
      return readTurnCompletedNotificationTurnId(message.params)
    }
    return undefined
  }

  function isStaleTurnMessage(message: DeferredTurnMessage): boolean {
    const turnId = readDeferredTurnId(message)
    return turnId !== undefined && staleTurnIds.has(turnId)
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
