import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

import {
  emitCompletedMessages,
  handleEvent as handleOpenCodeEvent,
  readAssistantFailure,
  renderText,
  type MessageText,
} from "./event"
import type { OpenCodeProviderEvent } from "./event"
import { answerQuestion, resolvePermission } from "./interaction"
import { parseModel } from "./model"
import { acquireServer, type OpencodeProcessOptions, type OpencodeServerLease } from "./proc"
import { onAbort } from "../../util/abort"
import { createAbortError, isAbortError, normalizeError } from "../../util/error"
import type { InteractionHandler } from "../../session/interaction"
import type { ActionStepOutput } from "../../session/step"

type EventPumpResult = { kind: "aborted" } | { kind: "completed" } | { error: Error; kind: "failed" }
type AbortSessionResult = { kind: "aborted" } | { error: Error; kind: "failed" }

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
      let aborting: Promise<AbortSessionResult> | undefined

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
        const abortResult: AbortSessionResult = aborting === undefined ? { kind: "aborted" } : await aborting
        await activeLease.stopNow()
        if (abortResult.kind === "failed") {
          capture.diagnostics.push(abortResult.error.message)
        }
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
        await emitCompletedMessages(
          (event) => emitEvent(capture, event, input.onEvent),
          messageText,
          response.parts,
          sessionId,
        )
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

async function abortSession(lease: OpencodeServerLease, cwd: string, sessionId: string): Promise<AbortSessionResult> {
  try {
    await lease.client.session.abort({
      directory: cwd,
      sessionID: sessionId,
    })
    return { kind: "aborted" }
  } catch (error) {
    return { error: normalizeError(error), kind: "failed" }
  }
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
          await handleOpenCodeEvent(event, {
            cwd: ctx.cwd,
            emit: (providerEvent) => emitEvent(ctx.capture, providerEvent, ctx.onEvent),
            lease: ctx.lease,
            messageText: ctx.messageText,
            onPermission: (request, tool) =>
              resolvePermission(ctx.interactionHandler, ctx.permissionMode, request, tool),
            onPermissionReply: async (request, decision) => {
              await ctx.lease.client.permission.reply({
                directory: ctx.cwd,
                reply: decision,
                requestID: request.id,
              })
            },
            onQuestion: (request) => answerQuestion(ctx.interactionHandler, request),
            onQuestionReject: async (request) => {
              await ctx.lease.client.question.reject({
                directory: ctx.cwd,
                requestID: request.id,
              })
            },
            onQuestionReply: async (request, answers) => {
              await ctx.lease.client.question.reply({
                answers,
                directory: ctx.cwd,
                requestID: request.id,
              })
            },
            sessionId: ctx.sessionId,
            toolCalls: ctx.toolCalls,
            toolState: ctx.toolState,
          })
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
