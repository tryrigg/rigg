import type {
  AssistantMessage,
  Event,
  EventMessagePartUpdated,
  Part,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2"

import type { OpenCodeProviderEvent } from "./event"
import { parseModel } from "./model"
import { acquireServer, type OpencodeProcessOptions, type OpencodeServerLease } from "./proc"
import { onAbort } from "../util/abort"
import { createAbortError, isAbortError, normalizeError } from "../util/error"
import type { ApprovalRequest, InteractionHandler, UserInputRequest } from "../session/interaction"
import type { ActionStepOutput } from "../session/step"

type EventPumpResult = { kind: "aborted" } | { kind: "completed" } | { error: Error; kind: "failed" }

type MessageText = {
  completed: boolean
  text: string
}

type EventContext = {
  capture: SessionCapture
  cwd: string
  interactionHandler?: InteractionHandler | undefined
  lease: OpencodeServerLease
  messageText: Map<string, MessageText>
  onEvent?: ((event: OpenCodeProviderEvent) => Promise<void> | void) | undefined
  permissionMode: "auto_approve" | "default"
  sessionId: string
  toolCalls: Map<string, string>
  toolState: Map<string, string>
}

type OpencodeRuntimeOptions = OpencodeProcessOptions & {
  internals?: OpencodeRuntimeInternals | undefined
  scopeId: string
  signal?: AbortSignal | undefined
}

export type OpencodeRuntimeInternals = {
  acquireServer?: typeof acquireServer
}

type OpencodeRuntimeSession = {
  close: () => Promise<void>
  run: (input: {
    agent?: string | undefined
    cwd: string
    interactionHandler?: InteractionHandler | undefined
    model?: string | undefined
    onEvent?: ((event: OpenCodeProviderEvent) => Promise<void> | void) | undefined
    permissionMode?: "auto_approve" | "default" | undefined
    prompt: string
    signal?: AbortSignal | undefined
    variant?: string | undefined
  }) => Promise<ActionStepOutput>
}

type SessionCapture = {
  diagnostics: string[]
  providerEvents: OpenCodeProviderEvent[]
}

export async function createOpencodeRuntimeSession(options: OpencodeRuntimeOptions): Promise<OpencodeRuntimeSession> {
  const acquire = options.internals?.acquireServer ?? acquireServer
  let closed = false
  let lease: OpencodeServerLease | undefined

  return {
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      if (lease !== undefined) {
        await lease.close()
        lease = undefined
      }
    },
    run: async (input) => {
      if (closed) {
        throw new Error("opencode runtime session closed")
      }

      const capture: SessionCapture = { diagnostics: [], providerEvents: [] }
      const signal = input.signal ?? options.signal
      const agent = input.agent ?? "build"
      const permissionMode = input.permissionMode ?? "default"
      const modelResult = parseModel(input.model)
      if (modelResult.kind === "invalid") {
        const message = modelResult.message
        await emitEvent(
          capture,
          {
            kind: "error",
            message,
            provider: "opencode",
          },
          input.onEvent,
        )
        return {
          exitCode: 1,
          providerEvents: [...capture.providerEvents],
          result: null,
          stderr: message,
          stdout: "",
          termination: "failed",
        }
      }
      const parsedModel =
        modelResult.kind === "ok" ? { modelID: modelResult.modelID, providerID: modelResult.providerID } : undefined

      lease = await acquire({
        binaryPath: options.binaryPath,
        cwd: input.cwd,
        env: options.env,
        onDiagnostic: async (message) => {
          capture.diagnostics.push(message)
          await emitEvent(
            capture,
            {
              kind: "diagnostic",
              message,
              provider: "opencode",
            },
            input.onEvent,
          )
        },
        scopeId: options.scopeId,
        signal,
      })

      try {
        await ensureAgent(lease, input.cwd, agent)
      } catch (error) {
        const message = renderProviderFailure(error)
        await emitEvent(
          capture,
          {
            kind: "error",
            message,
            provider: "opencode",
          },
          input.onEvent,
        )
        return {
          exitCode: 1,
          providerEvents: [...capture.providerEvents],
          result: null,
          stderr: message,
          stdout: "",
          termination: "failed",
        }
      }

      const activeLease = lease
      let sessionId: string
      try {
        const session = expectData(
          "OpenCode session.create",
          await activeLease.client.session.create({
            directory: input.cwd,
            title: "Rigg",
          }),
        )
        sessionId = session.id
      } catch (error) {
        const message = renderProviderFailure(error)
        await emitEvent(
          capture,
          {
            kind: "error",
            message,
            provider: "opencode",
          },
          input.onEvent,
        )
        return {
          exitCode: 1,
          providerEvents: [...capture.providerEvents],
          result: null,
          stderr: message,
          stdout: "",
          termination: "failed",
        }
      }
      const messageText = new Map<string, MessageText>()
      const toolCalls = new Map<string, string>()
      const toolState = new Map<string, string>()
      const eventAbort = new AbortController()
      const promptAbort = new AbortController()
      let promptDone = false
      let interrupted = false
      let aborting: Promise<void> | undefined

      const disposeAbort = onAbort(signal, () => {
        interrupted = true
        const err = createAbortError(signal?.reason)
        promptAbort.abort(err)
        eventAbort.abort(err)
        aborting ??= abortSession(activeLease, input.cwd, sessionId)
      })

      await emitEvent(
        capture,
        {
          agent,
          cwd: input.cwd,
          kind: "session_started",
          model: input.model ?? null,
          permissionMode,
          provider: "opencode",
          sessionId,
          variant: input.variant ?? null,
        },
        input.onEvent,
      )

      const events = pumpEvents(
        {
          capture,
          cwd: input.cwd,
          interactionHandler: input.interactionHandler,
          lease: activeLease,
          messageText,
          onEvent: input.onEvent,
          permissionMode,
          sessionId,
          toolCalls,
          toolState,
        },
        eventAbort.signal,
        () => promptDone,
      )
      const eventFailure = events.then((result) => {
        if (result.kind !== "failed") {
          return
        }
        promptAbort.abort(result.error)
        aborting ??= abortSession(activeLease, input.cwd, sessionId)
      })

      let response:
        | {
            info: AssistantMessage
            parts: Part[]
          }
        | undefined
      let promptError: Error | undefined

      try {
        const request = {
          agent,
          directory: input.cwd,
          parts: [{ text: input.prompt, type: "text" as const }],
          sessionID: sessionId,
          ...(parsedModel === undefined ? {} : { model: parsedModel }),
          ...(input.variant === undefined ? {} : { variant: input.variant }),
        }
        response = expectData(
          "OpenCode session.prompt",
          await activeLease.client.session.prompt(request, { signal: promptAbort.signal }),
        )
      } catch (error) {
        promptError = normalizeError(error)
      } finally {
        promptDone = true
        eventAbort.abort()
      }

      const eventResult = await events
      await eventFailure
      const stdout = renderText(response?.parts, messageText)
      const assistantError = readAssistantFailure(response?.info.error)

      if (interrupted || signal?.aborted) {
        await aborting
        await activeLease.stopNow()
        await emitEvent(
          capture,
          {
            kind: "session_completed",
            provider: "opencode",
            sessionId,
            status: "interrupted",
          },
          input.onEvent,
        )
        disposeAbort()
        return {
          exitCode: 130,
          providerEvents: [...capture.providerEvents],
          result: null,
          stderr: capture.diagnostics.join("\n"),
          stdout,
          termination: "interrupted",
        }
      }

      if (eventResult.kind === "failed") {
        await emitEvent(
          capture,
          {
            kind: "error",
            message: eventResult.error.message,
            provider: "opencode",
            sessionId,
          },
          input.onEvent,
        )
        disposeAbort()
        return {
          exitCode: 1,
          providerEvents: [...capture.providerEvents],
          result: null,
          stderr: eventResult.error.message,
          stdout,
          termination: "failed",
        }
      }

      const failure = promptError ?? assistantError
      if (failure !== undefined) {
        const message = renderProviderFailure(failure)
        await emitEvent(
          capture,
          {
            kind: "error",
            message,
            provider: "opencode",
            sessionId,
          },
          input.onEvent,
        )
        disposeAbort()
        return {
          exitCode: 1,
          providerEvents: [...capture.providerEvents],
          result: null,
          stderr: message,
          stdout,
          termination: "failed",
        }
      }

      if (response !== undefined) {
        await emitCompletedMessages(capture, response.parts, input.onEvent, messageText, sessionId)
      }

      await emitEvent(
        capture,
        {
          kind: "session_completed",
          provider: "opencode",
          sessionId,
          status: "completed",
        },
        input.onEvent,
      )
      disposeAbort()

      return {
        exitCode: 0,
        providerEvents: [...capture.providerEvents],
        result: stdout,
        stderr: capture.diagnostics.join("\n"),
        stdout,
        termination: "completed",
      }
    },
  }
}

async function abortSession(lease: OpencodeServerLease, cwd: string, sessionId: string): Promise<void> {
  try {
    await lease.client.session.abort({
      directory: cwd,
      sessionID: sessionId,
    })
  } catch {}
}

async function emitCompletedMessages(
  capture: SessionCapture,
  parts: Part[],
  onEvent: ((event: OpenCodeProviderEvent) => Promise<void> | void) | undefined,
  messageText: Map<string, MessageText>,
  sessionId: string,
): Promise<void> {
  for (const part of parts) {
    if (part.type !== "text") {
      continue
    }
    const stored = messageText.get(part.id)
    if (stored?.completed) {
      continue
    }
    messageText.set(part.id, {
      completed: true,
      text: part.text,
    })
    await emitEvent(
      capture,
      {
        kind: "message_completed",
        messageId: part.messageID,
        partId: part.id,
        provider: "opencode",
        sessionId,
        text: part.text,
      },
      onEvent,
    )
  }
}

async function emitTextUpdate(
  capture: SessionCapture,
  ctx: {
    messageText: Map<string, MessageText>
    onEvent?: ((event: OpenCodeProviderEvent) => Promise<void> | void) | undefined
    sessionId: string
  },
  part: Extract<Part, { type: "text" }>,
): Promise<void> {
  const prev = ctx.messageText.get(part.id)
  const text = part.text
  const completed = part.time?.end !== undefined
  ctx.messageText.set(part.id, {
    completed,
    text,
  })

  const delta = text.startsWith(prev?.text ?? "") ? text.slice(prev?.text.length ?? 0) : ""
  if (delta.length > 0) {
    await emitEvent(
      capture,
      {
        kind: "message_delta",
        messageId: part.messageID,
        partId: part.id,
        provider: "opencode",
        sessionId: ctx.sessionId,
        text: delta,
      },
      ctx.onEvent,
    )
  }

  if (!completed || prev?.completed) {
    return
  }

  await emitEvent(
    capture,
    {
      kind: "message_completed",
      messageId: part.messageID,
      partId: part.id,
      provider: "opencode",
      sessionId: ctx.sessionId,
      text,
    },
    ctx.onEvent,
  )
}

async function emitEvent(
  capture: SessionCapture,
  event: OpenCodeProviderEvent,
  onEvent?: ((event: OpenCodeProviderEvent) => Promise<void> | void) | undefined,
): Promise<void> {
  capture.providerEvents.push(event)
  await onEvent?.(event)
}

async function ensureAgent(lease: OpencodeServerLease, cwd: string, agent: string): Promise<void> {
  const agents = expectData("OpenCode app.agents", await lease.client.app.agents({ directory: cwd }))
  if (agents.some((candidate) => candidate.name === agent)) {
    return
  }

  throw new Error(`Unknown OpenCode agent "${agent}". Run \`opencode\` and pick a valid agent name.`)
}

async function handleEvent(event: Event, ctx: EventContext): Promise<void> {
  if ("properties" in event && "sessionID" in event.properties && event.properties.sessionID !== ctx.sessionId) {
    return
  }

  switch (event.type) {
    case "message.part.delta":
      if (event.properties.field !== "text" || event.properties.delta.length === 0) {
        return
      }
      ctx.messageText.set(event.properties.partID, {
        completed: false,
        text: (ctx.messageText.get(event.properties.partID)?.text ?? "") + event.properties.delta,
      })
      await emitEvent(
        ctx.capture,
        {
          kind: "message_delta",
          messageId: event.properties.messageID,
          partId: event.properties.partID,
          provider: "opencode",
          sessionId: ctx.sessionId,
          text: event.properties.delta,
        },
        ctx.onEvent,
      )
      return
    case "message.part.updated":
      await handlePartUpdated(event, ctx)
      return
    case "permission.asked":
      await handlePermissionAsked(event.properties, ctx)
      return
    case "permission.replied":
      return
    case "question.asked":
      await handleQuestionAsked(event.properties, ctx)
      return
    case "question.replied":
    case "question.rejected":
      return
    case "session.error":
      if (event.properties.error === undefined) {
        return
      }
      await emitEvent(
        ctx.capture,
        {
          kind: "error",
          message: renderProviderFailure(event.properties.error),
          provider: "opencode",
          sessionId: ctx.sessionId,
        },
        ctx.onEvent,
      )
      return
    case "server.instance.disposed":
      ctx.lease.markStale()
      await emitEvent(
        ctx.capture,
        {
          kind: "diagnostic",
          message: "OpenCode server instance was disposed.",
          provider: "opencode",
          sessionId: ctx.sessionId,
        },
        ctx.onEvent,
      )
      return
    default:
      return
  }
}

async function handlePartUpdated(event: EventMessagePartUpdated, ctx: EventContext): Promise<void> {
  const part = event.properties.part

  if (part.type === "text") {
    await emitTextUpdate(ctx.capture, ctx, part)
    return
  }

  if (part.type !== "tool") {
    return
  }

  ctx.toolCalls.set(part.callID, part.tool)
  const previous = ctx.toolState.get(part.id)
  ctx.toolState.set(part.id, part.state.status)

  if (part.state.status === "running" && previous !== "running") {
    await emitEvent(
      ctx.capture,
      {
        detail: summarizeToolDetail(part),
        kind: "tool_started",
        provider: "opencode",
        sessionId: ctx.sessionId,
        tool: part.tool,
      },
      ctx.onEvent,
    )
    return
  }

  if ((part.state.status === "completed" || part.state.status === "error") && previous !== part.state.status) {
    await emitEvent(
      ctx.capture,
      {
        detail: summarizeToolDetail(part),
        kind: "tool_completed",
        provider: "opencode",
        sessionId: ctx.sessionId,
        tool: part.tool,
      },
      ctx.onEvent,
    )
  }
}

async function handlePermissionAsked(request: PermissionRequest, ctx: EventContext): Promise<void> {
  const tool = ctx.toolCalls.get(request.tool?.callID ?? "") ?? request.permission
  const detail = request.patterns.join(", ")

  await emitEvent(
    ctx.capture,
    {
      detail: detail.length === 0 ? undefined : detail,
      kind: "permission_requested",
      message: detail.length === 0 ? `Allow ${tool}?` : `Allow ${tool}: ${detail}?`,
      permissionId: request.id,
      provider: "opencode",
      sessionId: ctx.sessionId,
      tool,
    },
    ctx.onEvent,
  )

  const decision = await resolvePermission(ctx, request, tool)
  await ctx.lease.client.permission.reply({
    directory: ctx.cwd,
    reply: decision,
    requestID: request.id,
  })
  await emitEvent(
    ctx.capture,
    {
      decision,
      kind: "permission_resolved",
      permissionId: request.id,
      provider: "opencode",
      sessionId: ctx.sessionId,
      tool,
    },
    ctx.onEvent,
  )
}

async function handleQuestionAsked(request: QuestionRequest, ctx: EventContext): Promise<void> {
  if (ctx.interactionHandler === undefined) {
    await ctx.lease.client.question.reject({
      directory: ctx.cwd,
      requestID: request.id,
    })
    return
  }

  const input = createUserInputRequest(request)
  const resolution = await ctx.interactionHandler(input)
  if (resolution.kind !== "user_input") {
    await ctx.lease.client.question.reject({
      directory: ctx.cwd,
      requestID: request.id,
    })
    throw new Error(`OpenCode question flow expected a user_input resolution, received ${resolution.kind}.`)
  }

  await ctx.lease.client.question.reply({
    answers: createQuestionAnswers(request, input, resolution.answers),
    directory: ctx.cwd,
    requestID: request.id,
  })
}

async function pumpEvents(
  ctx: EventContext,
  signal: AbortSignal,
  isPromptDone: () => boolean,
): Promise<EventPumpResult> {
  let attempts = 0
  let lastEventId: string | undefined

  while (true) {
    let events
    try {
      events = await ctx.lease.client.event.subscribe(
        {
          directory: ctx.cwd,
        },
        {
          headers: lastEventId === undefined ? undefined : { "Last-Event-ID": lastEventId },
          onSseEvent: (event) => {
            if (event.id !== undefined) {
              lastEventId = event.id
            }
          },
          signal,
          sseMaxRetryAttempts: 0,
        },
      )
      attempts = 0
    } catch (error) {
      const result = await handleEventPumpError(ctx, signal, error, attempts)
      if (result.kind !== "retry") {
        return result
      }
      attempts = result.attempts
      await Bun.sleep(50)
      continue
    }

    try {
      for await (const event of events.stream) {
        if (signal.aborted) {
          return { kind: "aborted" }
        }
        attempts = 0
        try {
          await handleEvent(event, ctx)
        } catch (error) {
          const normalized = normalizeError(error)
          if (signal.aborted || isAbortError(normalized)) {
            return { kind: "aborted" }
          }
          return { error: normalized, kind: "failed" }
        }
      }
    } catch (error) {
      const result = await handleEventPumpError(ctx, signal, error, attempts)
      if (result.kind !== "retry") {
        return result
      }
      attempts = result.attempts
      await Bun.sleep(50)
      continue
    }

    if (signal.aborted || isPromptDone()) {
      return { kind: "completed" }
    }

    await Bun.sleep(10)
  }
}

async function handleEventPumpError(
  ctx: EventContext,
  signal: AbortSignal,
  error: unknown,
  attempts: number,
): Promise<EventPumpResult | { attempts: number; kind: "retry" }> {
  const normalized = normalizeError(error)
  if (signal.aborted || isAbortError(normalized)) {
    return { kind: "aborted" }
  }

  const healthy = await ctx.lease.client.global.health().then(
    (result) => result.error === undefined && result.data?.healthy === true,
    () => false,
  )

  if (!healthy) {
    ctx.lease.markStale()
    return {
      error: new Error(
        "OpenCode server died mid-step while streaming events. Restart it with `opencode serve` or rerun the workflow.",
      ),
      kind: "failed",
    }
  }

  const next = attempts + 1
  if (next > 2) {
    return {
      error: new Error(
        `OpenCode event stream disconnected repeatedly for session ${ctx.sessionId}. Re-run the workflow or restart the server with \`opencode serve\`.`,
      ),
      kind: "failed",
    }
  }

  return { attempts: next, kind: "retry" }
}

function readAssistantFailure(error: AssistantMessage["error"] | undefined): Error | undefined {
  if (error === undefined) {
    return undefined
  }
  if (error.name === "ProviderAuthError") {
    return new Error(`${error.data.providerID} authentication failed: ${error.data.message}`)
  }
  if ("data" in error && error.data !== undefined && typeof error.data === "object" && "message" in error.data) {
    const message = error.data.message
    if (typeof message === "string" && message.length > 0) {
      return new Error(message)
    }
  }
  return new Error(error.name)
}

function renderProviderFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return normalizeError(error).message
}

function renderText(parts: Part[] | undefined, messageText: Map<string, MessageText>): string {
  if (parts !== undefined) {
    const text = parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text.length > 0) {
      return text
    }
  }

  return [...messageText.values()]
    .map((part) => part.text)
    .join("\n")
    .trim()
}

async function resolvePermission(
  ctx: EventContext,
  request: PermissionRequest,
  tool: string,
): Promise<"always" | "once" | "reject"> {
  if (ctx.permissionMode === "auto_approve") {
    return "always"
  }

  if (ctx.interactionHandler === undefined) {
    return "reject"
  }

  const resolution = await ctx.interactionHandler(createPermissionRequest(request, tool))
  if (resolution.kind !== "approval") {
    throw new Error(`OpenCode permission flow expected an approval resolution, received ${resolution.kind}.`)
  }
  if (resolution.decision === "once" || resolution.decision === "always" || resolution.decision === "reject") {
    return resolution.decision
  }

  throw new Error(`Unsupported OpenCode permission decision "${resolution.decision}".`)
}

function createUserInputRequest(request: QuestionRequest): UserInputRequest {
  return {
    itemId: request.id,
    kind: "user_input",
    questions: request.questions.map((question, index) => ({
      allowEmpty: false,
      header: question.header.slice(0, 12),
      id: questionId(index),
      isOther: question.custom !== false,
      isSecret: false,
      options: question.options.length === 0 ? null : question.options.map((option) => ({ ...option })),
      preserveWhitespace: true,
      question: formatQuestion(question),
    })),
    requestId: request.id,
    turnId: request.sessionID,
  }
}

function createQuestionAnswers(
  request: QuestionRequest,
  input: UserInputRequest,
  answers: Record<string, { answers: string[] }>,
): string[][] {
  return input.questions.map((question, index) => {
    const values = answers[question.id]?.answers ?? []
    return normalizeQuestionAnswers(values, request.questions[index])
  })
}

function normalizeQuestionAnswers(
  values: string[],
  question: QuestionRequest["questions"][number] | undefined,
): string[] {
  if (question === undefined) {
    return []
  }

  if (!question.multiple) {
    const value = values[0]
    if (value === undefined) {
      return []
    }
    return [normalizeQuestionChoice(value, question.options)]
  }

  return values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => normalizeQuestionChoice(part, question.options)),
  )
}

function normalizeQuestionChoice(answer: string, options: QuestionRequest["questions"][number]["options"]): string {
  if (!/^\d+$/.test(answer)) {
    return answer
  }

  const index = Number.parseInt(answer, 10)
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1]?.label ?? answer
  }
  return answer
}

function formatQuestion(question: QuestionRequest["questions"][number]): string {
  if (!question.multiple) {
    return question.question
  }

  return `${question.question}\nEnter one or more answers separated by commas.`
}

function questionId(index: number): string {
  return `question_${index + 1}`
}

function createPermissionRequest(request: PermissionRequest, tool: string): ApprovalRequest {
  const detail = request.patterns.join(", ")

  return {
    command: null,
    cwd: null,
    decisions: [
      {
        intent: "approve",
        label: "Allow once",
        value: "once",
      },
      {
        intent: "approve",
        label: "Always allow",
        value: "always",
      },
      {
        intent: "deny",
        label: "Reject",
        value: "reject",
      },
    ],
    itemId: request.id,
    kind: "approval",
    message: detail.length === 0 ? `Allow ${tool}?` : `Allow ${tool}: ${detail}?`,
    requestId: request.id,
    requestKind: "permissions",
    turnId: request.sessionID,
  }
}

function summarizeToolDetail(part: Extract<Part, { type: "tool" }>): string | undefined {
  if (part.state.status === "running" || part.state.status === "completed") {
    return part.state.title
  }
  if (part.state.status === "error") {
    return part.state.error
  }
  return undefined
}

function expectData<T, TError>(
  operation: string,
  result:
    | {
        data: T
        error: undefined
      }
    | {
        data: undefined
        error: TError
      },
): T {
  if (result.error !== undefined) {
    throw new Error(`${operation} failed: ${renderProviderFailure(result.error)}`, { cause: result.error })
  }

  if (result.data === undefined) {
    throw new Error(`${operation} returned no data`)
  }
  return result.data
}
