import type {
  AssistantMessage,
  Event,
  EventMessagePartUpdated,
  Part,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2"

export type OpenCodeProviderEvent =
  | {
      agent: string
      cwd: string
      kind: "session_started"
      model: string | null
      permissionMode: "auto_approve" | "default"
      provider: "opencode"
      sessionId: string
      variant: string | null
    }
  | {
      kind: "session_completed"
      provider: "opencode"
      sessionId: string
      status: string
    }
  | {
      kind: "message_delta"
      messageId: string | null
      partId: string
      provider: "opencode"
      sessionId: string
      text: string
    }
  | {
      kind: "message_completed"
      messageId: string | null
      partId: string
      provider: "opencode"
      sessionId: string
      text: string
    }
  | {
      detail?: string | undefined
      kind: "tool_started"
      provider: "opencode"
      sessionId: string
      tool: string
    }
  | {
      detail?: string | undefined
      kind: "tool_completed"
      provider: "opencode"
      sessionId: string
      tool: string
    }
  | {
      detail?: string | undefined
      kind: "permission_requested"
      message: string
      permissionId: string
      provider: "opencode"
      sessionId: string
      tool: string
    }
  | {
      decision: "always" | "once" | "reject"
      kind: "permission_resolved"
      permissionId: string
      provider: "opencode"
      sessionId: string
      tool: string
    }
  | {
      kind: "diagnostic"
      message: string
      provider: "opencode"
      sessionId?: string | null | undefined
    }
  | {
      kind: "error"
      message: string
      provider: "opencode"
      sessionId?: string | null | undefined
    }

export type MessageText = {
  completed: boolean
  text: string
}

type EventHandlerContext = {
  cwd: string
  emit: (event: OpenCodeProviderEvent) => Promise<void>
  lease: { markStale: () => void }
  messageText: Map<string, MessageText>
  onPermission: (request: PermissionRequest, tool: string) => Promise<"always" | "once" | "reject">
  onPermissionReply: (request: PermissionRequest, decision: "always" | "once" | "reject") => Promise<void>
  onQuestion: (request: QuestionRequest) => Promise<null | string[][]>
  onQuestionReject: (request: QuestionRequest) => Promise<void>
  onQuestionReply: (request: QuestionRequest, answers: string[][]) => Promise<void>
  sessionId: string
  toolCalls: Map<string, string>
  toolState: Map<string, string>
}

export async function emitCompletedMessages(
  emit: (event: OpenCodeProviderEvent) => Promise<void>,
  messageText: Map<string, MessageText>,
  parts: Part[],
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
    await emit({
      kind: "message_completed",
      messageId: part.messageID,
      partId: part.id,
      provider: "opencode",
      sessionId,
      text: part.text,
    })
  }
}

export async function handleEvent(event: Event, ctx: EventHandlerContext): Promise<void> {
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
      await ctx.emit({
        kind: "message_delta",
        messageId: event.properties.messageID,
        partId: event.properties.partID,
        provider: "opencode",
        sessionId: ctx.sessionId,
        text: event.properties.delta,
      })
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
      await ctx.emit({
        kind: "error",
        message: renderProviderFailure(event.properties.error),
        provider: "opencode",
        sessionId: ctx.sessionId,
      })
      return
    case "server.instance.disposed":
      ctx.lease.markStale()
      await ctx.emit({
        kind: "diagnostic",
        message: "OpenCode server instance was disposed.",
        provider: "opencode",
        sessionId: ctx.sessionId,
      })
      return
    default:
      return
  }
}

export function readAssistantFailure(error: AssistantMessage["error"] | undefined): Error | undefined {
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

export function renderText(parts: Part[] | undefined, messageText: Map<string, MessageText>): string {
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

function summarizeToolDetail(part: Extract<Part, { type: "tool" }>): string | undefined {
  if (part.state.status === "running" || part.state.status === "completed") {
    return part.state.title
  }
  if (part.state.status === "error") {
    return part.state.error
  }
  return undefined
}

async function handlePartUpdated(event: EventMessagePartUpdated, ctx: EventHandlerContext): Promise<void> {
  const part = event.properties.part
  if (part.type === "text") {
    await emitTextUpdate(ctx, part)
    return
  }
  if (part.type !== "tool") {
    return
  }

  ctx.toolCalls.set(part.callID, part.tool)
  const previous = ctx.toolState.get(part.id)
  ctx.toolState.set(part.id, part.state.status)

  if (part.state.status === "running" && previous !== "running") {
    await ctx.emit({
      detail: summarizeToolDetail(part),
      kind: "tool_started",
      provider: "opencode",
      sessionId: ctx.sessionId,
      tool: part.tool,
    })
    return
  }

  if ((part.state.status === "completed" || part.state.status === "error") && previous !== part.state.status) {
    await ctx.emit({
      detail: summarizeToolDetail(part),
      kind: "tool_completed",
      provider: "opencode",
      sessionId: ctx.sessionId,
      tool: part.tool,
    })
  }
}

async function emitTextUpdate(ctx: EventHandlerContext, part: Extract<Part, { type: "text" }>): Promise<void> {
  const prev = ctx.messageText.get(part.id)
  const text = part.text
  const completed = part.time?.end !== undefined
  ctx.messageText.set(part.id, {
    completed,
    text,
  })

  const delta = text.startsWith(prev?.text ?? "") ? text.slice(prev?.text.length ?? 0) : ""
  if (delta.length > 0) {
    await ctx.emit({
      kind: "message_delta",
      messageId: part.messageID,
      partId: part.id,
      provider: "opencode",
      sessionId: ctx.sessionId,
      text: delta,
    })
  }

  if (!completed || prev?.completed) {
    return
  }

  await ctx.emit({
    kind: "message_completed",
    messageId: part.messageID,
    partId: part.id,
    provider: "opencode",
    sessionId: ctx.sessionId,
    text,
  })
}

async function handlePermissionAsked(request: PermissionRequest, ctx: EventHandlerContext): Promise<void> {
  const tool = ctx.toolCalls.get(request.tool?.callID ?? "") ?? request.permission
  const detail = request.patterns.join(", ")

  await ctx.emit({
    detail: detail.length === 0 ? undefined : detail,
    kind: "permission_requested",
    message: detail.length === 0 ? `Allow ${tool}?` : `Allow ${tool}: ${detail}?`,
    permissionId: request.id,
    provider: "opencode",
    sessionId: ctx.sessionId,
    tool,
  })

  const decision = await ctx.onPermission(request, tool)
  await ctx.onPermissionReply(request, decision)
  await ctx.emit({
    decision,
    kind: "permission_resolved",
    permissionId: request.id,
    provider: "opencode",
    sessionId: ctx.sessionId,
    tool,
  })
}

async function handleQuestionAsked(request: QuestionRequest, ctx: EventHandlerContext): Promise<void> {
  const answers = await ctx.onQuestion(request)
  if (answers === null) {
    await ctx.onQuestionReject(request)
    return
  }

  await ctx.onQuestionReply(request, answers)
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

  return String(error)
}
