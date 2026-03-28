import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

type PendingTool = {
  detail?: string | undefined
  id: string
  name: string
}

export function readSessionStart(message: SDKMessage): { cwd: string; model: string | null; sessionId: string } | null {
  if (message.type !== "system" || message.subtype !== "init") {
    return null
  }

  return {
    cwd: message.cwd,
    model: message.model,
    sessionId: message.session_id,
  }
}

export function readStreamDelta(
  message: SDKMessage,
  streamId: string | null,
): { messageId: string; text: string } | null {
  if (message.type !== "stream_event") {
    return null
  }

  const text = extractTextDelta(message.event)
  if (text === null) {
    return null
  }

  return {
    messageId: streamMessageId(message) ?? streamId ?? message.uuid,
    text,
  }
}

export function readAssistantMessage(
  message: SDKMessage,
  streamId: string | null,
): {
  error: string | null
  messageId: string
  text: string
  tools: PendingTool[]
} | null {
  if (message.type !== "assistant") {
    return null
  }

  return {
    error: message.error === undefined ? null : normalizeProviderError(message.error),
    messageId: streamId ?? assistantMessageId(message) ?? message.session_id,
    text: extractAssistantText(message),
    tools: extractAssistantTools(message),
  }
}

export function readToolProgress(message: SDKMessage): { id: string; name: string } | null {
  if (message.type !== "tool_progress") {
    return null
  }

  return {
    id: message.tool_use_id,
    name: message.tool_name,
  }
}

export function readToolSummary(message: SDKMessage): { detail: string; ids: string[] } | null {
  if (message.type !== "tool_use_summary") {
    return null
  }

  return {
    detail: message.summary,
    ids: message.preceding_tool_use_ids,
  }
}

export function readAuthMessages(message: SDKMessage): Array<{ kind: "diagnostic" | "error"; message: string }> {
  if (message.type !== "auth_status") {
    return []
  }

  const kind = message.error ? "error" : "diagnostic"
  return [...message.output, message.error]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .map((line) => ({
      kind,
      message: normalizeProviderError(line),
    }))
}

export function readResultStatus(message: SDKMessage): string | null {
  if (message.type !== "result") {
    return null
  }

  return message.subtype === "success" ? "completed" : message.subtype
}

export function normalizeProviderError(message: string): string {
  if (isAuthFailure(message)) {
    return "Claude CLI is not authenticated. Run `claude login` to authenticate, then retry."
  }

  return message
}

function extractTextDelta(event: unknown): string | null {
  const value = record(event)
  if (value === null || value["type"] !== "content_block_delta") {
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

function extractAssistantTools(message: Extract<SDKMessage, { type: "assistant" }>): PendingTool[] {
  return recordArray(message.message.content).flatMap((item) => {
    if (item["type"] !== "tool_use") {
      return []
    }
    if (typeof item["id"] !== "string" || typeof item["name"] !== "string") {
      return []
    }

    return [
      {
        detail: summarizeToolInput(item["name"], item["input"]),
        id: item["id"],
        name: item["name"],
      },
    ]
  })
}

function summarizeToolInput(tool: string, input: unknown): string {
  const payload = record(input)
  if (payload !== null && typeof payload["command"] === "string") {
    return payload["command"]
  }

  const detail = stringifyToolInput(input)
  const next = `${tool} (${detail})`
  return next.length > 160 ? `${next.slice(0, 157)}...` : next
}

function stringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
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
