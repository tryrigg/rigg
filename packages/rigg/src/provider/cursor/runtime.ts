import { onAbort } from "../../util/abort"
import { isAbortError, normalizeError } from "../../util/error"
import { isJsonObject } from "../../util/json"
import { createPromiseKit } from "../../util/promise"
import { RIGG_VERSION } from "../../version"
import type { CursorProviderEvent } from "./event"
import {
  parseExtensionRequest,
  parsePermissionRequest,
  parseSessionNew,
  parseSessionUpdates,
  readSessionId,
} from "./protocol"
import { assertVersion, startServer, type CursorProcessOptions } from "./proc"
import { createRpcClient } from "./rpc"
import type { InteractionRequest, InteractionResolution, InteractionHandler } from "../../session/interaction"

type CursorRuntimeOptions = CursorProcessOptions & { signal?: AbortSignal | undefined }

type CursorMode = "agent" | "ask" | "plan"

type InitializeParams = {
  clientCapabilities: Record<string, never>
  clientInfo: {
    name: string
    title: string
    version: string
  }
  protocolVersion: number
}

type SessionCapture = {
  diagnostics: string[]
  providerEvents: CursorProviderEvent[]
}

type CursorSessionResult = {
  diagnostics: string[]
  providerEvents: CursorProviderEvent[]
  status: string
  text: string
}

type PromptState =
  | { kind: "interrupting" }
  | { kind: "running" }
  | { kind: "settled"; status: string }
  | {
      generation: number
      kind: "waiting_quiet"
      sawActivity: boolean
      status: string
      timer?: ReturnType<typeof setTimeout> | undefined
    }

type SessionExecution = {
  capture: SessionCapture
  mode: CursorMode
  cleanup: () => void
  interactionHandler?: InteractionHandler | undefined
  messageOrder: string[]
  messages: Map<string, string>
  onEvent?: ((event: CursorProviderEvent) => Promise<void> | void) | undefined
  prompt: PromptState
  reject: (error: Error) => void
  resolve: (value: CursorSessionResult) => void
  sessionId: string
}

export type CursorStepResult = {
  exitCode: number
  providerEvents: CursorProviderEvent[]
  result: unknown
  stderr: string
  stdout: string
  termination: "completed" | "failed" | "interrupted"
}

export type CursorRuntimeSession = {
  close: () => Promise<void>
  run: (options: {
    cwd: string
    interactionHandler?: InteractionHandler | undefined
    mode: CursorMode
    onEvent?: ((event: CursorProviderEvent) => Promise<void> | void) | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }) => Promise<CursorStepResult>
}

export async function createCursorRuntimeSession(options: CursorRuntimeOptions): Promise<CursorRuntimeSession> {
  const INTERRUPT_REQUEST_TIMEOUT_MS = 1_000
  const INTERRUPT_TIMEOUT_MESSAGE = "timed out waiting for cursor agent acp response to session/cancel"
  const POST_PROMPT_QUIET_PERIOD_MS = 50

  assertVersion(options)

  const acp = startServer(options)
  const rpc = createRpcClient(acp)
  const executions = new Map<string, SessionExecution>()
  const ignoredSessionUpdates = new Set<string>()
  let closed = false

  function captureEvent(
    capture: SessionCapture,
    event: CursorProviderEvent,
    onEvent?: ((event: CursorProviderEvent) => Promise<void> | void) | undefined,
  ): Promise<void> | void {
    capture.providerEvents.push(event)
    return onEvent?.(event)
  }

  function appendDiagnostic(line: string, sessionId?: string): void {
    const execution = sessionId === undefined ? singleExecution() : executions.get(sessionId)
    if (execution === undefined) {
      return
    }

    execution.capture.diagnostics.push(line)
    void captureEvent(
      execution.capture,
      {
        kind: "diagnostic",
        message: line,
        provider: "cursor",
        sessionId: execution.sessionId,
      },
      execution.onEvent,
    )
  }

  function singleExecution(): SessionExecution | undefined {
    if (executions.size !== 1) {
      return undefined
    }
    const execution = executions.values().next()
    return execution.done ? undefined : execution.value
  }

  function finalizeFailed(result: CursorSessionResult): CursorStepResult {
    const interrupted = result.status === "interrupted"
    return {
      exitCode: interrupted ? 130 : 1,
      providerEvents: [...result.providerEvents],
      result: null,
      stderr: result.diagnostics.join("\n"),
      stdout: result.text,
      termination: interrupted ? "interrupted" : "failed",
    }
  }

  function interruptedStepResult(capture: SessionCapture): CursorStepResult {
    return {
      exitCode: 130,
      providerEvents: [...capture.providerEvents],
      result: null,
      stderr: capture.diagnostics.join("\n"),
      stdout: "",
      termination: "interrupted",
    }
  }

  function isSettled(execution: SessionExecution): boolean {
    return execution.prompt.kind === "settled"
  }

  function rejectExecution(execution: SessionExecution, error: Error): void {
    if (isSettled(execution)) {
      return
    }

    execution.prompt = { kind: "settled", status: "failed" }
    clearPromptSettlement(execution)
    execution.cleanup()
    ignoreLateSessionUpdates(execution.sessionId)
    executions.delete(execution.sessionId)
    execution.reject(error)
  }

  function settleExecution(execution: SessionExecution, result: CursorSessionResult): void {
    if (isSettled(execution)) {
      return
    }

    execution.prompt = { kind: "settled", status: result.status }
    clearPromptSettlement(execution)
    execution.cleanup()
    ignoreLateSessionUpdates(execution.sessionId)
    executions.delete(execution.sessionId)
    execution.resolve(result)
  }

  function ignoreLateSessionUpdates(sessionId: string): void {
    ignoredSessionUpdates.add(sessionId)
  }

  function renderMessages(execution: SessionExecution): string {
    return execution.messageOrder
      .map((messageId) => execution.messages.get(messageId) ?? "")
      .filter((text) => text.length > 0)
      .join("\n")
  }

  function ensureMessage(execution: SessionExecution, messageId: string | null): string {
    const key = messageId ?? execution.sessionId
    if (!execution.messages.has(key)) {
      execution.messages.set(key, "")
      execution.messageOrder.push(key)
    }
    return key
  }

  async function emitSessionCompleted(execution: SessionExecution, status: string): Promise<void> {
    await captureEvent(
      execution.capture,
      {
        kind: "session_completed",
        provider: "cursor",
        sessionId: execution.sessionId,
        status,
      },
      execution.onEvent,
    )
  }

  function readPromptStopReason(promptResult: unknown): string | null {
    if (!isJsonObject(promptResult)) {
      return null
    }
    const stopReason = promptResult["stopReason"]
    return typeof stopReason === "string" && stopReason.length > 0 ? normalizeStopReason(stopReason) : null
  }

  function clearPromptSettlement(execution: SessionExecution): void {
    if (execution.prompt.kind !== "waiting_quiet" || execution.prompt.timer === undefined) {
      return
    }

    clearTimeout(execution.prompt.timer)
    execution.prompt = {
      generation: execution.prompt.generation,
      kind: "waiting_quiet",
      sawActivity: execution.prompt.sawActivity,
      status: execution.prompt.status,
    }
  }

  async function settlePromptTurn(execution: SessionExecution, generation: number): Promise<void> {
    if (execution.prompt.kind !== "waiting_quiet" || execution.prompt.generation !== generation) {
      return
    }

    const status = execution.prompt.status
    await rpc.whenIdle()
    if (execution.prompt.kind !== "waiting_quiet" || execution.prompt.generation !== generation) {
      return
    }

    await emitSessionCompleted(execution, status)
    settleExecution(execution, {
      diagnostics: execution.capture.diagnostics,
      providerEvents: execution.capture.providerEvents,
      status,
      text: renderMessages(execution),
    })
  }

  function schedulePromptTurnSettlement(execution: SessionExecution): void {
    const status = execution.prompt.kind === "waiting_quiet" ? execution.prompt.status : null
    if (isSettled(execution) || status === null) {
      return
    }

    clearPromptSettlement(execution)
    const generation = execution.prompt.kind === "waiting_quiet" ? execution.prompt.generation + 1 : 1
    const timer = setTimeout(() => {
      if (execution.prompt.kind === "waiting_quiet" && execution.prompt.generation === generation) {
        execution.prompt = {
          generation,
          kind: "waiting_quiet",
          sawActivity: execution.prompt.sawActivity,
          status: execution.prompt.status,
        }
      }
      void settlePromptTurn(execution, generation).catch((error) => {
        rejectExecution(execution, normalizeError(error))
      })
    }, POST_PROMPT_QUIET_PERIOD_MS)
    execution.prompt = {
      generation,
      kind: "waiting_quiet",
      sawActivity: false,
      status,
      timer,
    }
  }

  function recordPostPromptActivity(execution: SessionExecution): void {
    if (execution.prompt.kind !== "waiting_quiet") {
      return
    }

    execution.prompt = {
      generation: execution.prompt.generation,
      kind: "waiting_quiet",
      sawActivity: true,
      status: execution.prompt.status,
      timer: execution.prompt.timer,
    }
  }

  async function interruptExecution(execution: SessionExecution): Promise<void> {
    if (isSettled(execution) || execution.prompt.kind === "interrupting") {
      return
    }
    if (execution.prompt.kind === "waiting_quiet" && !execution.prompt.sawActivity) {
      return
    }

    execution.prompt = { kind: "interrupting" }
    try {
      await rpc.request(
        "session/cancel",
        { sessionId: execution.sessionId },
        { timeoutMs: INTERRUPT_REQUEST_TIMEOUT_MS },
      )
    } catch (error) {
      const normalized = normalizeError(error)
      if (normalized.message !== INTERRUPT_TIMEOUT_MESSAGE) {
        rejectExecution(execution, normalized)
        return
      }
    }

    try {
      await emitSessionCompleted(execution, "interrupted")
    } catch (error) {
      rejectExecution(execution, normalizeError(error))
      return
    }

    settleExecution(execution, {
      diagnostics: execution.capture.diagnostics,
      providerEvents: execution.capture.providerEvents,
      status: "interrupted",
      text: renderMessages(execution),
    })
  }

  acp.stderr.onLine((line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      return
    }
    appendDiagnostic(trimmed)
  })

  rpc.start({
    onError: async (error) => {
      for (const execution of [...executions.values()]) {
        rejectExecution(execution, error)
      }
    },
    onNotification: async (message) => {
      await handleNotification(message.method, message.params)
    },
    onRequest: async (message) => {
      await handleRequest(message.id, message.method, message.params)
    },
  })

  try {
    await rpc.request(
      "initialize",
      {
        clientCapabilities: {},
        clientInfo: {
          name: "@tryrigg/rigg",
          title: "Rigg",
          version: RIGG_VERSION,
        },
        protocolVersion: 1,
      } satisfies InitializeParams,
      { signal: options.signal },
    )
    await rpc.request("authenticate", { methodId: "cursor_login" }, { signal: options.signal })
  } catch (error) {
    const bootstrapError = normalizeError(error)
    try {
      await close()
    } catch (closeError) {
      throw new Error("failed to close cursor runtime session after bootstrap failure", {
        cause: new AggregateError([bootstrapError, normalizeError(closeError)]),
      })
    }
    throw bootstrapError
  }

  async function run(options_: {
    cwd: string
    interactionHandler?: InteractionHandler | undefined
    mode: CursorMode
    onEvent?: ((event: CursorProviderEvent) => Promise<void> | void) | undefined
    prompt: string
    signal?: AbortSignal | undefined
  }): Promise<CursorStepResult> {
    const capture: SessionCapture = { diagnostics: [], providerEvents: [] }
    let sessionId: string
    try {
      sessionId = parseSessionNew(
        await rpc.request(
          "session/new",
          {
            cwd: options_.cwd,
            mcpServers: [],
            mode: options_.mode,
          },
          { signal: options_.signal },
        ),
      )
    } catch (error) {
      if (options_.signal?.aborted && isAbortError(error)) {
        await close()
        return interruptedStepResult(capture)
      }
      throw normalizeError(error)
    }

    const resultPromise = createPromiseKit<CursorSessionResult>()
    const execution: SessionExecution = {
      capture,
      mode: options_.mode,
      cleanup: () => {},
      interactionHandler: options_.interactionHandler,
      messageOrder: [],
      messages: new Map(),
      onEvent: options_.onEvent,
      prompt: { kind: "running" },
      reject: resultPromise.reject,
      resolve: resultPromise.resolve,
      sessionId,
    }
    executions.set(sessionId, execution)

    let disposeAbort = () => {}
    execution.cleanup = () => {
      disposeAbort()
    }

    disposeAbort = onAbort(options_.signal, () => {
      void interruptExecution(execution)
    })

    await captureEvent(
      capture,
      {
        cwd: options_.cwd,
        kind: "session_started",
        mode: options_.mode,
        provider: "cursor",
        sessionId,
      },
      options_.onEvent,
    )

    let promptResult: unknown
    try {
      promptResult = await rpc.request(
        "session/prompt",
        {
          prompt: [{ text: options_.prompt, type: "text" }],
          sessionId,
        },
        { signal: options_.signal, timeoutMs: null },
      )
    } catch (error) {
      if (options_.signal?.aborted && isAbortError(error)) {
        return finalizeInterrupt(await resultPromise.promise)
      }
      execution.prompt = { kind: "settled", status: "failed" }
      execution.cleanup()
      ignoreLateSessionUpdates(execution.sessionId)
      executions.delete(execution.sessionId)
      throw normalizeError(error)
    }

    const stopReason = readPromptStopReason(promptResult)
    if (stopReason !== null) {
      execution.prompt = {
        generation: 0,
        kind: "waiting_quiet",
        sawActivity: false,
        status: stopReason,
      }
      schedulePromptTurnSettlement(execution)
    }

    let result: CursorSessionResult
    try {
      result = await resultPromise.promise
    } catch (error) {
      if (options_.signal?.aborted && isAbortError(error)) {
        await close()
        return interruptedStepResult(capture)
      }
      throw normalizeError(error)
    }

    if (result.status !== "completed") {
      return finalizeFailed(result)
    }

    return {
      exitCode: 0,
      providerEvents: [...result.providerEvents],
      result: result.text,
      stderr: result.diagnostics.join("\n"),
      stdout: result.text,
      termination: "completed",
    }
  }

  function finalizeInterrupt(result: CursorSessionResult): CursorStepResult {
    return {
      exitCode: 130,
      providerEvents: [...result.providerEvents],
      result: null,
      stderr: result.diagnostics.join("\n"),
      stdout: result.text,
      termination: "interrupted",
    }
  }

  async function handleRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const sessionId = readSessionId(params)
    const execution = sessionId === undefined ? singleExecution() : executions.get(sessionId)
    if (execution === undefined) {
      throw new Error("cursor acp referenced an unknown session")
    }

    if (execution.interactionHandler === undefined) {
      throw new Error(`cursor acp requested interaction via ${method}, but no interaction handler is configured`)
    }

    const request = parseInteractionRequest(method, String(id), params)
    const resolution = await execution.interactionHandler(request)
    assertResolutionKind("approval", resolution)
    assertApprovalDecision(request, resolution.decision)
    rpc.respond(id, { outcome: { optionId: resolution.decision, outcome: "selected" } })
  }

  async function handleNotification(method: string, params: unknown): Promise<void> {
    if (method === "session/update") {
      for (const update of parseSessionUpdates(params)) {
        if (update.sessionId === "") {
          continue
        }
        const execution = executions.get(update.sessionId)
        if (execution === undefined) {
          if (ignoredSessionUpdates.has(update.sessionId)) {
            return
          }
          throw new Error("cursor acp referenced an unknown session")
        }

        switch (update.kind) {
          case "noop":
            schedulePromptTurnSettlement(execution)
            continue
          case "tool_call":
            recordPostPromptActivity(execution)
            schedulePromptTurnSettlement(execution)
            continue
          case "message_delta": {
            if (update.text.length === 0) {
              schedulePromptTurnSettlement(execution)
              continue
            }
            recordPostPromptActivity(execution)
            const messageId = ensureMessage(execution, update.messageId)
            execution.messages.set(messageId, (execution.messages.get(messageId) ?? "") + update.text)
            await captureEvent(
              execution.capture,
              {
                kind: "message_delta",
                messageId: update.messageId,
                provider: "cursor",
                sessionId: update.sessionId,
                text: update.text,
              },
              execution.onEvent,
            )
            schedulePromptTurnSettlement(execution)
            continue
          }
          case "diagnostic":
            recordPostPromptActivity(execution)
            execution.capture.diagnostics.push(update.message)
            await captureEvent(
              execution.capture,
              {
                kind: "diagnostic",
                message: update.message,
                provider: "cursor",
                sessionId: update.sessionId,
              },
              execution.onEvent,
            )
            schedulePromptTurnSettlement(execution)
            continue
          case "error":
            recordPostPromptActivity(execution)
            execution.capture.diagnostics.push(update.message)
            await captureEvent(
              execution.capture,
              {
                kind: "error",
                message: update.message,
                provider: "cursor",
                sessionId: update.sessionId,
              },
              execution.onEvent,
            )
            schedulePromptTurnSettlement(execution)
            continue
          case "unknown":
            if (update.type === "missing_update_kind" || update.type === "invalid_envelope") {
              schedulePromptTurnSettlement(execution)
              continue
            }
            recordPostPromptActivity(execution)
            appendDiagnostic(`cursor acp notification: session/update:${update.type}`, update.sessionId)
            schedulePromptTurnSettlement(execution)
            continue
        }
      }
    }

    if (method.startsWith("cursor/")) {
      appendDiagnostic(`cursor acp notification: ${method}`, readSessionId(params))
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return
    }
    closed = true
    for (const execution of [...executions.values()]) {
      rejectExecution(execution, new Error("cursor runtime session closed"))
    }
    ignoredSessionUpdates.clear()
    await rpc.close()
  }

  return {
    close,
    run,
  }
}

function parseInteractionRequest(
  method: string,
  requestId: string,
  params: unknown,
): Extract<InteractionRequest, { kind: "approval" }> {
  switch (method) {
    case "session/request_permission":
      return parsePermissionRequest(requestId, params)
    case "cursor/ask_question":
    case "cursor/create_plan":
      return parseExtensionRequest(method, requestId, params)
    default:
      throw new Error(`unsupported Cursor ACP request: ${method}`)
  }
}

function normalizeStopReason(stopReason: string): string {
  if (stopReason === "end_turn") {
    return "completed"
  }
  if (stopReason === "cancelled") {
    return "interrupted"
  }
  return stopReason
}

function assertResolutionKind<TKind extends InteractionRequest["kind"]>(
  expected: TKind,
  resolution: InteractionResolution,
): asserts resolution is Extract<InteractionResolution, { kind: TKind }> {
  if (resolution.kind !== expected) {
    throw new Error(`interaction handler returned ${resolution.kind} for ${expected}`)
  }
}

function assertApprovalDecision(request: Extract<InteractionRequest, { kind: "approval" }>, decision: string): void {
  if (request.decisions.some((candidate) => candidate.value === decision)) {
    return
  }

  throw new Error(`interaction handler returned invalid approval decision: ${decision}`)
}
