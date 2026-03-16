import { z } from "zod"

import { createStepFailedError } from "../run/error"
import { normalizeError } from "../util/error"
import { parseJson } from "../util/json"
import type { CodexProviderEvent } from "./event"
import { inferApprovalDecisionIntent, type CodexInteractionRequest } from "./interaction"
import type { CodexReviewResult } from "./review"

const JsonObjectSchema = z.record(z.string(), z.unknown())
const NullableStringSchema = z.string().nullable().optional()

const AccountReadResultSchema = z.object({
  account: z.unknown().nullable().optional(),
  requiresOpenaiAuth: z.boolean().optional(),
})

const ThreadStartResponseSchema = z.object({
  thread: z.object({
    id: z.string(),
  }),
})

const TurnStartResponseSchema = z.object({
  turn: z.object({
    id: z.string(),
  }),
})

const CollaborationModeKindSchema = z.union([z.literal("default"), z.literal("plan")])

const CollaborationModeMaskSchema = z.object({
  mode: CollaborationModeKindSchema.nullable().optional(),
  model: z.string().nullable().optional(),
  name: z.string(),
  reasoning_effort: z
    .union([z.literal("minimal"), z.literal("low"), z.literal("medium"), z.literal("high"), z.literal("xhigh")])
    .nullable()
    .optional(),
})

const CollaborationModeListResponseSchema = z.object({
  data: z.array(CollaborationModeMaskSchema),
})

const ErrorNotificationSchema = z.object({
  message: z.string().optional(),
  threadId: NullableStringSchema,
  turnId: NullableStringSchema,
})

const MessageDeltaNotificationSchema = z.object({
  delta: z.string().optional(),
  itemId: NullableStringSchema,
})

const ItemNotificationSchema = z.object({
  item: JsonObjectSchema,
  turnId: z.string().optional(),
})

const TurnCompletedNotificationSchema = z.object({
  turn: z.object({
    error: z
      .object({
        message: z.string().optional(),
      })
      .nullable()
      .optional(),
    id: z.string(),
    status: z.string().optional(),
  }),
})

const TurnScopedParamsSchema = z.object({
  turnId: z.string(),
})

const ApprovalRequestSchema = z.object({
  availableDecisions: z.array(z.string()),
  command: z.string().optional(),
  cwd: z.string().optional(),
  itemId: z.string(),
  reason: z.string().optional(),
  turnId: z.string(),
})

const UserInputQuestionOptionSchema = z.object({
  description: z.string(),
  label: z.string(),
})

const UserInputQuestionSchema = z.object({
  header: z.string(),
  id: z.string(),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  options: z.array(UserInputQuestionOptionSchema).nullable().optional(),
  question: z.string(),
})

const UserInputRequestSchema = z.object({
  itemId: z.string(),
  questions: z.array(UserInputQuestionSchema),
  turnId: z.string(),
})

const FormElicitationRequestSchema = z.object({
  message: z.string(),
  mode: z.literal("form"),
  requestedSchema: JsonObjectSchema.optional(),
  serverName: z.string(),
  turnId: NullableStringSchema,
})

const UrlElicitationRequestSchema = z.object({
  elicitationId: z.string(),
  message: z.string(),
  mode: z.literal("url"),
  serverName: z.string(),
  turnId: NullableStringSchema,
  url: z.string(),
})

const CommandExecutionItemSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional(),
  id: NullableStringSchema,
  type: z.literal("commandExecution"),
})

const McpToolCallItemSchema = z.object({
  id: NullableStringSchema,
  server: z.string().optional(),
  tool: z.string().optional(),
  type: z.literal("mcpToolCall"),
})

const FileChangeItemSchema = z.object({
  id: NullableStringSchema,
  type: z.literal("fileChange"),
})

const DynamicToolCallItemSchema = z.object({
  id: NullableStringSchema,
  tool: z.string().optional(),
  type: z.literal("dynamicToolCall"),
})

const AgentMessageItemSchema = z.object({
  id: NullableStringSchema,
  text: z.string().optional(),
  type: z.literal("agentMessage"),
})

const ReviewItemSchema = z.object({
  review: z.string().optional(),
  type: z.union([z.literal("codeReview"), z.literal("exitedReviewMode")]),
})

export type ReviewThreadTarget =
  | { type: "base"; value: string }
  | { type: "commit"; value: string }
  | { type: "uncommitted" }

export type CollaborationModeKind = z.infer<typeof CollaborationModeKindSchema>

export type CollaborationModeMask = {
  mode: CollaborationModeKind | null
  model: string | null
  name: string
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh" | null
}

export type ReviewStartTarget =
  | { branch: string; type: "baseBranch" }
  | { sha: string; type: "commit" }
  | { type: "uncommittedChanges" }

export type ErrorNotification = {
  message: string
  threadId: string | null
  turnId: string | null
}

export type MessageDeltaNotification = {
  itemId: string | null
  text: string | null
}

export type ItemNotification = {
  item: Record<string, unknown>
}

export type TurnCompletedNotification = {
  errorMessage: string | null
  status: string
  turnId: string
}

function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new Error(message, { cause: result.error })
  }

  return result.data
}

export function ensureAuthenticatedAccount(account: unknown): void {
  const parsed = parseWithSchema(
    AccountReadResultSchema,
    account,
    "codex app-server returned an invalid account/read response",
  )
  if (parsed.requiresOpenaiAuth === true && parsed.account === null) {
    throw new Error("Codex CLI is not authenticated. Run `codex login` and retry.")
  }
}

export function parseThreadStartResponse(response: unknown): string {
  return parseWithSchema(ThreadStartResponseSchema, response, "thread/start response did not include a thread id")
    .thread.id
}

export function parseTurnStartResponse(method: "review/start" | "turn/start", response: unknown): string {
  return parseWithSchema(TurnStartResponseSchema, response, `${method} response did not include a turn id`).turn.id
}

export function parseCollaborationModeListResponse(response: unknown): CollaborationModeMask[] {
  const parsed = parseWithSchema(
    CollaborationModeListResponseSchema,
    response,
    "collaborationMode/list response did not include collaboration modes",
  )

  return parsed.data.map((mask) => ({
    mode: mask.mode ?? null,
    model: mask.model ?? null,
    name: mask.name,
    reasoning_effort: mask.reasoning_effort ?? null,
  }))
}

export function parseErrorNotification(params: unknown): ErrorNotification {
  const parsed = parseWithSchema(ErrorNotificationSchema, params, "codex app-server sent an invalid error notification")

  return {
    message: parsed.message ?? "codex app-server reported an error",
    threadId: parsed.threadId ?? null,
    turnId: parsed.turnId ?? null,
  }
}

export function parseMessageDeltaNotification(params: unknown): MessageDeltaNotification {
  const parsed = parseWithSchema(
    MessageDeltaNotificationSchema,
    params,
    "codex app-server sent an invalid agentMessage delta notification",
  )

  return {
    itemId: parsed.itemId ?? null,
    text: parsed.delta ?? null,
  }
}

export function parseItemNotification(params: unknown): ItemNotification {
  const parsed = parseWithSchema(ItemNotificationSchema, params, "codex app-server sent an invalid item notification")
  return { item: parsed.item }
}

export function parseTurnCompletedNotification(params: unknown): TurnCompletedNotification {
  const parsed = parseWithSchema(
    TurnCompletedNotificationSchema,
    params,
    "codex app-server sent an invalid turn/completed notification",
  )

  return {
    errorMessage: parsed.turn.error?.message ?? null,
    status: parsed.turn.status ?? "failed",
    turnId: parsed.turn.id,
  }
}

export function readTurnCompletedNotificationTurnId(params: unknown): string | undefined {
  const result = TurnCompletedNotificationSchema.safeParse(params)
  return result.success ? result.data.turn.id : undefined
}

export function readTurnIdFromParams(params: unknown): string | undefined {
  const result = TurnScopedParamsSchema.safeParse(params)
  return result.success ? result.data.turnId : undefined
}

export function parseApprovalRequest(
  requestKind: "command_execution" | "file_change" | "permissions",
  requestId: string,
  params: unknown,
): Extract<CodexInteractionRequest, { kind: "approval" }> {
  const parsed = parseWithSchema(
    ApprovalRequestSchema,
    params,
    `codex app-server sent invalid ${requestKind} approval params`,
  )

  return {
    command: parsed.command,
    cwd: parsed.cwd,
    decisions: parsed.availableDecisions.map((value) => ({
      intent: inferApprovalDecisionIntent(value),
      value,
    })),
    itemId: parsed.itemId,
    kind: "approval",
    message: parsed.reason ?? `${requestKind.replaceAll("_", " ")} approval requested`,
    requestId,
    requestKind,
    turnId: parsed.turnId,
  }
}

export function readPermissionsPayload(params: unknown): Record<string, unknown> {
  const record = parseWithSchema(JsonObjectSchema, params, "codex app-server sent invalid permissions approval params")
  const permissions = JsonObjectSchema.safeParse(record["permissions"])
  return permissions.success ? permissions.data : {}
}

export function parseUserInputRequest(
  requestId: string,
  params: unknown,
): Extract<CodexInteractionRequest, { kind: "user_input" }> {
  const parsed = parseWithSchema(
    UserInputRequestSchema,
    params,
    "codex app-server sent invalid requestUserInput params",
  )

  return {
    itemId: parsed.itemId,
    kind: "user_input",
    questions: parsed.questions.map((question) => ({
      header: question.header,
      id: question.id,
      isOther: question.isOther ?? false,
      isSecret: question.isSecret ?? false,
      options: question.options ?? null,
      question: question.question,
    })),
    requestId,
    turnId: parsed.turnId,
  }
}

export function parseElicitationRequest(
  requestId: string,
  params: unknown,
): Extract<CodexInteractionRequest, { kind: "elicitation" }> {
  const formResult = FormElicitationRequestSchema.safeParse(params)
  if (formResult.success) {
    return {
      itemId: null,
      kind: "elicitation",
      message: formResult.data.message,
      mode: "form",
      requestId,
      requestedSchema: formResult.data.requestedSchema ?? {},
      serverName: formResult.data.serverName,
      turnId: formResult.data.turnId ?? null,
    }
  }

  const urlResult = UrlElicitationRequestSchema.safeParse(params)
  if (urlResult.success) {
    return {
      elicitationId: urlResult.data.elicitationId,
      itemId: null,
      kind: "elicitation",
      message: urlResult.data.message,
      mode: "url",
      requestId,
      serverName: urlResult.data.serverName,
      turnId: urlResult.data.turnId ?? null,
      url: urlResult.data.url,
    }
  }

  throw new Error("codex app-server sent invalid elicitation params", {
    cause: formResult.error,
  })
}

export function parseCompletedAssistantMessage(item: Record<string, unknown>): {
  itemId: string | null
  text: string | null
} | null {
  const result = AgentMessageItemSchema.safeParse(item)
  if (!result.success) {
    return null
  }

  return {
    itemId: result.data.id ?? null,
    text: result.data.text ?? null,
  }
}

export function parseReviewItem(item: Record<string, unknown>): string | null {
  const result = ReviewItemSchema.safeParse(item)
  if (!result.success) {
    return null
  }

  return result.data.review ?? null
}

export function parseToolEvent(
  item: Record<string, unknown>,
  input: {
    itemId: string | null
    kind: "tool_completed" | "tool_started"
    threadId: string
    turnId: string
  },
): CodexProviderEvent | undefined {
  const commandExecution = CommandExecutionItemSchema.safeParse(item)
  if (commandExecution.success) {
    return {
      detail: summarizePairs(commandExecution.data, ["command", "cwd"]),
      itemId: input.itemId,
      kind: input.kind,
      provider: "codex",
      threadId: input.threadId,
      tool: "command_execution",
      turnId: input.turnId,
    }
  }

  const mcpToolCall = McpToolCallItemSchema.safeParse(item)
  if (mcpToolCall.success) {
    return {
      detail: summarizePairs(mcpToolCall.data, ["server"]),
      itemId: input.itemId,
      kind: input.kind,
      provider: "codex",
      threadId: input.threadId,
      tool: mcpToolCall.data.tool ?? "mcp_tool_call",
      turnId: input.turnId,
    }
  }

  const fileChange = FileChangeItemSchema.safeParse(item)
  if (fileChange.success) {
    return {
      itemId: input.itemId,
      kind: input.kind,
      provider: "codex",
      threadId: input.threadId,
      tool: "file_change",
      turnId: input.turnId,
    }
  }

  const dynamicToolCall = DynamicToolCallItemSchema.safeParse(item)
  if (dynamicToolCall.success) {
    return {
      itemId: input.itemId,
      kind: input.kind,
      provider: "codex",
      threadId: input.threadId,
      tool: dynamicToolCall.data.tool ?? "dynamic_tool_call",
      turnId: input.turnId,
    }
  }

  return undefined
}

export function mapReviewTarget(target: ReviewThreadTarget): ReviewStartTarget {
  if (target.type === "uncommitted") {
    return { type: "uncommittedChanges" }
  }
  if (target.type === "base") {
    return { branch: target.value, type: "baseBranch" }
  }

  return {
    sha: target.value,
    type: "commit",
  }
}

export function parseJsonOutput(text: string | undefined, source: string): unknown {
  try {
    return parseJson((text ?? "").trim())
  } catch (error) {
    const cause = normalizeError(error)
    throw createStepFailedError(new Error(`${source} step returned invalid JSON: ${cause.message}`, { cause }))
  }
}

export function parseReviewText(text: string): CodexReviewResult {
  const normalized = text.trim()
  const marker = normalized.indexOf("\nReview comment:")
  const pluralMarker = normalized.indexOf("\nFull review comments:")
  const headingIndex =
    marker >= 0
      ? marker + 1
      : pluralMarker >= 0
        ? pluralMarker + 1
        : normalized.startsWith("Review comment:") || normalized.startsWith("Full review comments:")
          ? 0
          : -1

  const explanation = (headingIndex >= 0 ? normalized.slice(0, headingIndex) : normalized).trim()
  const findingsBlock = headingIndex >= 0 ? normalized.slice(headingIndex) : ""

  return {
    findings: parseReviewFindings(findingsBlock),
    overall_confidence_score: 0,
    overall_correctness: "unknown",
    overall_explanation: explanation.length > 0 ? explanation : normalized,
  }
}

function parseReviewFindings(block: string): CodexReviewResult["findings"] {
  const findings: CodexReviewResult["findings"] = []
  let current:
    | {
        bodyLines: string[]
        location: string
        title: string
      }
    | undefined

  for (const line of block.split(/\r?\n/)) {
    if (isReviewBulletLine(line)) {
      const header = parseReviewFindingHeader(line)
      if (header === null) {
        throw createStepFailedError(new Error(`Codex review returned an unsupported finding header: ${line.trim()}`))
      }

      if (current !== undefined) {
        findings.push(finalizeReviewFinding(current))
      }
      current = {
        bodyLines: [],
        location: header.location,
        title: header.title,
      }
      continue
    }

    if (current !== undefined) {
      current.bodyLines.push(line.startsWith("  ") ? line.slice(2) : line)
    }
  }

  if (current !== undefined) {
    findings.push(finalizeReviewFinding(current))
  }

  return findings
}

function finalizeReviewFinding(input: {
  bodyLines: string[]
  location: string
  title: string
}): CodexReviewResult["findings"][number] {
  const location = parseReviewFindingLocation(input.location)
  if (location === null) {
    throw createStepFailedError(new Error(`Codex review returned an unsupported code location: ${input.location}`))
  }

  return {
    body: input.bodyLines.join("\n"),
    code_location: {
      absolute_file_path: location.absoluteFilePath,
      line_range: {
        end: location.end,
        start: location.start,
      },
    },
    confidence_score: 0,
    priority: null,
    title: input.title.trim(),
  }
}

function isReviewBulletLine(line: string): boolean {
  return line.startsWith("- ") || line.startsWith("- [x] ") || line.startsWith("- [ ] ")
}

function parseReviewFindingHeader(line: string): { location: string; title: string } | null {
  const bullet = /^- (?:\[[x ]\] )?(?<content>.+)$/.exec(line)
  const content = bullet?.groups?.["content"]?.trim()
  if (content === undefined || content.length === 0) {
    return null
  }

  const separatorIndex = content.lastIndexOf(" — ")
  if (separatorIndex <= 0) {
    return null
  }

  const title = content.slice(0, separatorIndex).trim()
  const location = content.slice(separatorIndex + " — ".length).trim()
  if (title.length === 0 || location.length === 0) {
    return null
  }

  return { location, title }
}

function parseReviewFindingLocation(location: string): { absoluteFilePath: string; end: number; start: number } | null {
  const normalized = location.trim()

  const columnRange = /^(.*):(\d+):(\d+)-(\d+):(\d+)$/.exec(normalized)
  if (columnRange !== null) {
    const absoluteFilePath = columnRange[1]
    const start = columnRange[2]
    const end = columnRange[4]
    if (absoluteFilePath === undefined || start === undefined || end === undefined) {
      return null
    }

    return {
      absoluteFilePath,
      end: Number.parseInt(end, 10),
      start: Number.parseInt(start, 10),
    }
  }

  const lineRange = /^(.*):(\d+)-(\d+)$/.exec(normalized)
  if (lineRange !== null) {
    const absoluteFilePath = lineRange[1]
    const start = lineRange[2]
    const end = lineRange[3]
    if (absoluteFilePath === undefined || start === undefined || end === undefined) {
      return null
    }

    return {
      absoluteFilePath,
      end: Number.parseInt(end, 10),
      start: Number.parseInt(start, 10),
    }
  }

  const singleLine = /^(.*):(\d+)$/.exec(normalized)
  if (singleLine !== null) {
    const absoluteFilePath = singleLine[1]
    const lineText = singleLine[2]
    if (absoluteFilePath === undefined || lineText === undefined) {
      return null
    }

    const line = Number.parseInt(lineText, 10)
    return {
      absoluteFilePath,
      end: line,
      start: line,
    }
  }

  return null
}

function summarizePairs(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const details = keys
    .map((key) => {
      const candidate = value[key]
      return typeof candidate === "string" && candidate.length > 0 ? `${key}=${candidate}` : undefined
    })
    .filter((detail): detail is string => detail !== undefined)

  return details.length === 0 ? undefined : details.join(" ")
}
