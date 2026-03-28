import { z } from "zod"

import { compactJson } from "../../util/json"
import { EffortSchema, type Effort } from "../../workflow/effort"
import type { CodexProviderEvent } from "./event"
import { inferApprovalDecisionIntent, type InteractionRequest } from "../../session/interaction"
export type CodexReviewResult = {
  findings: Array<{
    body: string
    code_location: {
      absolute_file_path: string
      line_range: {
        end: number
        start: number
      }
    }
    confidence_score: number
    priority?: number | null | undefined
    title: string
  }>
  overall_confidence_score: number
  overall_correctness: string
  overall_explanation: string
}

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
  reasoning_effort: EffortSchema.nullable().optional(),
})

const CollaborationModeListResponseSchema = z.object({
  data: z.array(CollaborationModeMaskSchema),
})

const ErrorNotificationSchema = z.object({
  error: z
    .object({
      message: z.string(),
    })
    .optional(),
  threadId: NullableStringSchema,
  turnId: NullableStringSchema,
  willRetry: z.boolean().optional(),
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

const CmdApprovalSchema = z.object({
  availableDecisions: z.array(z.unknown()).nullable().optional(),
  command: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  itemId: z.string(),
  reason: z.string().nullable().optional(),
  turnId: z.string(),
})

const FileApprovalSchema = z.object({
  grantRoot: z.string().nullable().optional(),
  itemId: z.string(),
  reason: z.string().nullable().optional(),
  turnId: z.string(),
})

const PermApprovalSchema = z.object({
  itemId: z.string(),
  permissions: JsonObjectSchema,
  reason: z.string().nullable().optional(),
  turnId: z.string(),
})

const UserInputQuestionOptionSchema = z.object({
  description: z.string(),
  label: z.string(),
})

const UserInputQuestionSchema = z.object({
  allowEmpty: z.boolean().optional(),
  header: z.string(),
  id: z.string(),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  options: z.array(UserInputQuestionOptionSchema).nullable().optional(),
  preserveWhitespace: z.boolean().optional(),
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
  reasoning_effort: Effort | null
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

export function ensureAuth(account: unknown): void {
  const parsed = parseWithSchema(
    AccountReadResultSchema,
    account,
    "codex app-server returned an invalid account/read response",
  )
  if (parsed.requiresOpenaiAuth === true && parsed.account === null) {
    throw new Error("Codex CLI is not authenticated. Run `codex login` and retry.")
  }
}

export function parseThreadStart(response: unknown): string {
  return parseWithSchema(ThreadStartResponseSchema, response, "thread/start response did not include a thread id")
    .thread.id
}

export function parseTurnStart(method: "review/start" | "turn/start", response: unknown): string {
  return parseWithSchema(TurnStartResponseSchema, response, `${method} response did not include a turn id`).turn.id
}

export function parseCollabModes(response: unknown): CollaborationModeMask[] {
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

export function parseError(params: unknown): ErrorNotification {
  const parsed = parseWithSchema(ErrorNotificationSchema, params, "codex app-server sent an invalid error notification")

  return {
    message: parsed.error?.message ?? "codex app-server reported an error",
    threadId: parsed.threadId ?? null,
    turnId: parsed.turnId ?? null,
  }
}

export function parseDelta(params: unknown): MessageDeltaNotification {
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

export function parseItem(params: unknown): ItemNotification {
  const parsed = parseWithSchema(ItemNotificationSchema, params, "codex app-server sent an invalid item notification")
  return { item: parsed.item }
}

export function parseTurnDone(params: unknown): TurnCompletedNotification {
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

export function readTurnId(params: unknown): string | undefined {
  const completed = TurnCompletedNotificationSchema.safeParse(params)
  if (completed.success) {
    return completed.data.turn.id
  }
  const scoped = TurnScopedParamsSchema.safeParse(params)
  return scoped.success ? scoped.data.turnId : undefined
}

export function parseApproval(
  requestKind: "command_execution" | "file_change" | "permissions",
  requestId: string,
  params: unknown,
): Extract<InteractionRequest, { kind: "approval" }> {
  const message = `codex app-server sent invalid ${requestKind} approval params`

  if (requestKind === "command_execution") {
    return parseCmdApproval(requestId, requestKind, params, message)
  }

  if (requestKind === "file_change") {
    return parseFileApproval(requestId, requestKind, params, message)
  }

  return parsePermApproval(requestId, requestKind, params, message)
}

export function parseUserInput(
  requestId: string,
  params: unknown,
): Extract<InteractionRequest, { kind: "user_input" }> {
  const parsed = parseWithSchema(
    UserInputRequestSchema,
    params,
    "codex app-server sent invalid requestUserInput params",
  )

  return {
    itemId: parsed.itemId,
    kind: "user_input",
    questions: parsed.questions.map((question) => ({
      ...(question.allowEmpty === undefined ? {} : { allowEmpty: question.allowEmpty }),
      header: question.header,
      id: question.id,
      isOther: question.isOther ?? false,
      isSecret: question.isSecret ?? false,
      options: question.options ?? null,
      ...(question.preserveWhitespace === undefined ? {} : { preserveWhitespace: question.preserveWhitespace }),
      question: question.question,
    })),
    requestId,
    turnId: parsed.turnId,
  }
}

export function parseElicitation(
  requestId: string,
  params: unknown,
): Extract<InteractionRequest, { kind: "elicitation" }> {
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

export function parseAssistantMessage(item: Record<string, unknown>): {
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
        throw new Error(`Codex review returned an unsupported finding header: ${line.trim()}`)
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
    throw new Error(`Codex review returned an unsupported code location: ${input.location}`)
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

function parseCmdApproval(
  requestId: string,
  requestKind: "command_execution",
  params: unknown,
  message: string,
): Extract<InteractionRequest, { kind: "approval" }> {
  const parsed = parseWithSchema(CmdApprovalSchema, params, message)
  return {
    command: parsed.command ?? undefined,
    cwd: parsed.cwd ?? undefined,
    decisions: parseCmdDecisions(parsed.availableDecisions),
    itemId: parsed.itemId,
    kind: "approval",
    message: approvalMsg(requestKind, parsed.reason),
    requestId,
    requestKind,
    turnId: parsed.turnId,
  }
}

function parseFileApproval(
  requestId: string,
  requestKind: "file_change",
  params: unknown,
  message: string,
): Extract<InteractionRequest, { kind: "approval" }> {
  const parsed = parseWithSchema(FileApprovalSchema, params, message)
  const values = parsed.grantRoot
    ? ["accept", "acceptForSession", "decline", "cancel"]
    : ["accept", "decline", "cancel"]
  return {
    command: undefined,
    cwd: undefined,
    decisions: values.map((value) => makeDecision(value)),
    itemId: parsed.itemId,
    kind: "approval",
    message: approvalMsg(requestKind, parsed.reason),
    requestId,
    requestKind,
    turnId: parsed.turnId,
  }
}

function parsePermApproval(
  requestId: string,
  requestKind: "permissions",
  params: unknown,
  message: string,
): Extract<InteractionRequest, { kind: "approval" }> {
  const parsed = parseWithSchema(PermApprovalSchema, params, message)
  const permissions = { ...parsed.permissions }
  return {
    command: undefined,
    cwd: undefined,
    decisions: [
      makeDecision("grant", { permissions, scope: "turn" }),
      makeDecision("grant_for_session", { permissions, scope: "session" }),
      makeDecision("decline", { permissions: {}, scope: "turn" }),
    ],
    itemId: parsed.itemId,
    kind: "approval",
    message: approvalMsg(requestKind, parsed.reason),
    requestId,
    requestKind,
    turnId: parsed.turnId,
  }
}

function approvalMsg(
  kind: "command_execution" | "file_change" | "permissions",
  reason: string | null | undefined,
): string {
  if (reason) return reason
  return `${kind.replaceAll("_", " ")} approval requested`
}

function parseCmdDecisions(
  input: unknown[] | null | undefined,
): Extract<InteractionRequest, { kind: "approval" }>["decisions"] {
  const source = input === undefined || input === null || input.length === 0 ? ["accept", "decline", "cancel"] : input
  const counts = new Map<string, number>()
  for (const item of source) {
    const key = decisionKey(item)
    if (key === null) {
      continue
    }
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const seen = new Map<string, number>()
  return source.map((item) => {
    if (typeof item === "string") {
      const index = (seen.get(item) ?? 0) + 1
      seen.set(item, index)
      return makeDecision(uniqueDecisionValue(item, index, counts.get(item) ?? 0), item)
    }

    if (item !== null && typeof item === "object") {
      const entries = Object.entries(item)
      if (entries.length === 1) {
        const [key, payload] = entries[0]!
        const index = (seen.get(key) ?? 0) + 1
        seen.set(key, index)
        return makeDecision(uniqueDecisionValue(key, index, counts.get(key) ?? 0), item, decisionLabel(key, payload))
      }
    }

    throw new Error("codex app-server sent unsupported approval decision")
  })
}

function decisionKey(item: unknown): string | null {
  if (typeof item === "string") {
    return item
  }
  if (item === null || typeof item !== "object") {
    return null
  }
  const entries = Object.entries(item)
  if (entries.length !== 1) {
    return null
  }
  const [key] = entries[0]!
  return key
}

function makeDecision(
  value: string,
  response?: unknown,
  label?: string,
): Extract<InteractionRequest, { kind: "approval" }>["decisions"][number] {
  return {
    intent: inferApprovalDecisionIntent(normalizeApprovalIntentToken(value)),
    ...(label === undefined ? {} : { label }),
    ...(response === undefined ? {} : { response }),
    value,
  }
}

function decisionLabel(key: string, payload: unknown): string {
  if (!isRecord(payload)) {
    return key
  }

  const keys = ["host", "action", "path", "root", "cwd", "command"]
  const detail = summarizePairs(payload, keys)
  if (detail === undefined) {
    return `${key} ${compactJson(payload)}`
  }
  if (
    Object.entries(payload).some(
      ([name, value]) => !keys.includes(name) || typeof value !== "string" || value.length === 0,
    )
  ) {
    return `${key} ${compactJson(payload)}`
  }
  return `${key} ${detail}`
}

function uniqueDecisionValue(key: string, index: number, total: number): string {
  if (total <= 1) {
    return key
  }
  return `${key}:${index}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function normalizeApprovalIntentToken(value: string): string {
  if (value === "acceptForSession") return "accept"
  if (value === "acceptWithExecpolicyAmendment" || value.startsWith("acceptWithExecpolicyAmendment:")) return "accept"
  if (value === "applyNetworkPolicyAmendment" || value.startsWith("applyNetworkPolicyAmendment:")) return "accept"
  if (value === "grant" || value === "grant_for_session") return "accept"
  return value
}
