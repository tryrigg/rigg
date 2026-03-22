import { z } from "zod"

import { inferApprovalDecisionIntent, type ApprovalRequest } from "../session/interaction"
import { isJsonObject } from "../util/json"

const SessionNewResponseSchema = z.object({
  sessionId: z.string().min(1),
})

const AcpPermissionOptionSchema = z
  .object({
    kind: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    optionId: z.string().min(1),
  })
  .passthrough()

const AcpToolCallSchema = z
  .object({
    content: z.array(z.unknown()).optional(),
    kind: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
  })
  .passthrough()

const AcpSessionPermissionRequestSchema = z.object({
  options: z.array(AcpPermissionOptionSchema).min(1),
  sessionId: z.string().min(1),
  toolCall: AcpToolCallSchema.optional(),
})

const CursorExtensionOptionSchema = z
  .object({
    description: z.string().optional(),
    id: z.union([z.string().min(1), z.number()]).optional(),
    kind: z.string().min(1).optional(),
    label: z.string().optional(),
    name: z.string().optional(),
    optionId: z.union([z.string().min(1), z.number()]).optional(),
    title: z.string().optional(),
    value: z.union([z.string().min(1), z.number()]).optional(),
  })
  .passthrough()

export type CursorSessionUpdate =
  | {
      kind: "message_delta"
      messageId: string | null
      sessionId: string
      text: string
    }
  | {
      kind: "tool_call"
      sessionId: string
    }
  | {
      kind: "diagnostic"
      message: string
      sessionId: string
    }
  | {
      kind: "error"
      message: string
      sessionId: string
    }
  | {
      kind: "noop"
      sessionId: string
    }
  | {
      kind: "unknown"
      sessionId: string
      type: string
    }

function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new Error(message, { cause: result.error })
  }

  return result.data
}

export function parseSessionNew(response: unknown): string {
  return parseWithSchema(SessionNewResponseSchema, response, "cursor acp sent invalid session/new payload").sessionId
}

function normalizeEnvelopeUpdate(update: Record<string, unknown>): Record<string, unknown> {
  const out = { ...update }
  if (typeof out["text"] !== "string") {
    const content = out["content"]
    if (isJsonObject(content) && content["type"] === "text" && typeof content["text"] === "string") {
      out["text"] = content["text"]
    }
  }
  return out
}

function readMessageId(raw: Record<string, unknown>): string | null {
  const id = raw["messageId"]
  if (id === null || id === undefined) {
    return null
  }
  if (typeof id === "string" || typeof id === "number") {
    return String(id)
  }
  return null
}

function extractUpdateObjects(params: Record<string, unknown>): Record<string, unknown>[] | undefined {
  const direct = params["update"]
  if (isJsonObject(direct)) {
    return [direct]
  }
  return undefined
}

function agentBodyText(normalized: Record<string, unknown>, update: Record<string, unknown>): string {
  if (typeof normalized["text"] === "string") {
    return normalized["text"]
  }
  const content = update["content"]
  return isJsonObject(content) && content["type"] === "text" && typeof content["text"] === "string"
    ? content["text"]
    : ""
}

function parseSessionUpdateObject(sessionId: string, update: Record<string, unknown>): CursorSessionUpdate {
  const normalized = normalizeEnvelopeUpdate(update)
  const kind = typeof normalized["sessionUpdate"] === "string" ? normalized["sessionUpdate"] : undefined
  if (kind === undefined) {
    return { kind: "unknown", sessionId, type: "missing_update_kind" }
  }

  if (
    kind === "user_message_chunk" ||
    kind === "available_commands_update" ||
    kind === "agent_thought_chunk" ||
    kind === "plan"
  ) {
    return { kind: "noop", sessionId }
  }

  switch (kind) {
    case "agent_message_chunk":
      return {
        kind: "message_delta",
        messageId: readMessageId(normalized),
        sessionId,
        text: agentBodyText(normalized, update),
      }
    case "tool_call":
    case "tool_call_update":
      return {
        kind: "tool_call",
        sessionId,
      }
    case "diagnostic": {
      const message =
        typeof normalized["message"] === "string" && normalized["message"].length > 0
          ? normalized["message"]
          : "cursor acp diagnostic"
      return {
        kind: "diagnostic",
        message,
        sessionId,
      }
    }
    case "error": {
      const message =
        typeof normalized["message"] === "string" && normalized["message"].length > 0
          ? normalized["message"]
          : "cursor acp reported an error"
      return {
        kind: "error",
        message,
        sessionId,
      }
    }
    default:
      return {
        kind: "unknown",
        sessionId,
        type: kind,
      }
  }
}

export function parseSessionUpdates(params: unknown): CursorSessionUpdate[] {
  if (!isJsonObject(params)) {
    return [{ kind: "unknown", sessionId: "", type: "invalid_params" }]
  }
  const sessionId = readSessionId(params)
  if (sessionId === undefined) {
    return [{ kind: "unknown", sessionId: "", type: "invalid_params" }]
  }
  const updates = extractUpdateObjects(params)
  if (updates === undefined) {
    return [{ kind: "unknown", sessionId, type: "invalid_envelope" }]
  }

  return updates.map((update) => parseSessionUpdateObject(sessionId, update))
}

export function parseSessionUpdate(params: unknown): CursorSessionUpdate {
  return parseSessionUpdates(params)[0] ?? { kind: "unknown", sessionId: "", type: "invalid_envelope" }
}

function permissionIntentFromKind(kind: string | undefined): "approve" | "deny" | null {
  const normalizedKind = kind?.trim().toLowerCase()
  if (normalizedKind === "allow_once" || normalizedKind === "allow_always") {
    return "approve"
  }
  if (normalizedKind === "reject_once") {
    return "deny"
  }
  return null
}

function permissionShortcut(kind: string | undefined): string | undefined {
  const normalizedKind = kind?.trim().toLowerCase()
  if (normalizedKind === "allow_once") {
    return "y"
  }
  if (normalizedKind === "allow_always") {
    return "a"
  }
  return undefined
}

function readTextContent(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value]
  }
  if (!isJsonObject(value)) {
    return []
  }
  if (value["type"] === "text" && typeof value["text"] === "string" && value["text"].length > 0) {
    return [value["text"]]
  }
  return readTextContent(value["content"])
}

function permissionMessageFromToolCall(toolCall: z.infer<typeof AcpToolCallSchema> | undefined): string {
  if (toolCall === undefined) {
    return "cursor permission requested"
  }

  const parts = [toolCall.title, ...(toolCall.content ?? []).flatMap((entry) => readTextContent(entry))].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  )

  if (parts.length > 0) {
    return parts.join("\n\n")
  }
  if (toolCall.kind !== undefined) {
    return `cursor permission requested for ${toolCall.kind}`
  }
  return "cursor permission requested"
}

function readInteractionOptions(params: Record<string, unknown>): z.infer<typeof CursorExtensionOptionSchema>[] {
  for (const key of ["options", "choices", "answers"]) {
    const value = params[key]
    if (Array.isArray(value)) {
      return value.flatMap((entry) => {
        const parsed = CursorExtensionOptionSchema.safeParse(entry)
        return parsed.success ? [parsed.data] : []
      })
    }
  }

  return []
}

function readInteractionOptionId(option: z.infer<typeof CursorExtensionOptionSchema>): string | undefined {
  const candidate = option.optionId ?? option.id ?? option.value
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate
  }
  if (typeof candidate === "number") {
    return String(candidate)
  }
  return undefined
}

function readInteractionMessage(params: Record<string, unknown>, fallback: string): string {
  const parts = [
    params["title"],
    params["message"],
    params["question"],
    params["prompt"],
    ...readTextContent(params["description"]),
    ...readTextContent(params["details"]),
    ...readTextContent(params["content"]),
    ...readTextContent(params["plan"]),
  ].filter((value): value is string => typeof value === "string" && value.length > 0)

  return parts.length > 0 ? parts.join("\n\n") : fallback
}

export function parsePermissionRequest(requestId: string, params: unknown): ApprovalRequest {
  const parsed = parseWithSchema(
    AcpSessionPermissionRequestSchema,
    params,
    "cursor acp sent invalid session/request_permission payload",
  )

  return {
    command: undefined,
    cwd: undefined,
    decisions: parsed.options.map((option) => ({
      intent: permissionIntentFromKind(option.kind),
      shortcut: permissionShortcut(option.kind),
      value: option.optionId,
    })),
    itemId: parsed.toolCall?.toolCallId ?? requestId,
    kind: "approval",
    message: permissionMessageFromToolCall(parsed.toolCall),
    requestId,
    requestKind: "permissions",
    turnId: parsed.sessionId,
  }
}

export function parseExtensionRequest(method: string, requestId: string, params: unknown): ApprovalRequest {
  if (!isJsonObject(params) || typeof params["sessionId"] !== "string" || params["sessionId"].length === 0) {
    throw new Error(`cursor acp sent invalid ${method} payload`)
  }

  const options = readInteractionOptions(params)
  if (options.length === 0) {
    throw new Error(`cursor acp sent ${method} payload without selectable options`)
  }

  return {
    command: undefined,
    cwd: undefined,
    decisions: options.map((option) => {
      const value = readInteractionOptionId(option)
      if (value === undefined) {
        throw new Error(`cursor acp sent ${method} option without an id`)
      }

      return {
        intent: inferApprovalDecisionIntent(option.kind ?? option.label ?? option.name ?? option.title ?? value),
        value,
      }
    }),
    itemId:
      typeof params["toolCallId"] === "string" && params["toolCallId"].length > 0
        ? params["toolCallId"]
        : typeof params["questionId"] === "string" && params["questionId"].length > 0
          ? params["questionId"]
          : typeof params["planId"] === "string" && params["planId"].length > 0
            ? params["planId"]
            : requestId,
    kind: "approval",
    message: readInteractionMessage(params, `cursor interaction requested via ${method}`),
    requestId,
    requestKind: "permissions",
    turnId: params["sessionId"],
  }
}

export function readSessionId(params: unknown): string | undefined {
  if (!isJsonObject(params)) {
    return undefined
  }
  const sessionId = params["sessionId"]
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return sessionId
  }
  return undefined
}
