import type { ElicitationRequest, ElicitationResult, PermissionResult } from "@anthropic-ai/claude-agent-sdk"

import type {
  ApprovalRequest,
  InteractionRequest,
  InteractionResolution,
  UserInputRequest,
} from "../../session/interaction"

export type ApprovalInput = {
  description?: string | undefined
  input: unknown
  sessionId: string
  title?: string | undefined
  tool: string
  toolUseID: string
}

export type UserInputPrompt = {
  fields: Record<string, Record<string, unknown>>
  request: UserInputRequest
}

export function createApprovalRequest(input: ApprovalInput): ApprovalRequest {
  const payload = record(input.input)
  const command = typeof payload?.["command"] === "string" ? payload["command"] : null
  const cwd = typeof payload?.["cwd"] === "string" ? payload["cwd"] : null
  const detail = summarizeToolInput(input.tool, input.input)

  return {
    command,
    cwd,
    decisions: [
      {
        intent: "approve",
        label: "Approve",
        response: { behavior: "allow", toolUseID: input.toolUseID },
        value: "allow",
      },
      {
        intent: "deny",
        label: "Deny",
        response: { behavior: "deny", message: "Denied by operator.", toolUseID: input.toolUseID },
        value: "deny",
      },
      {
        intent: "cancel",
        label: "Cancel",
        response: {
          behavior: "deny",
          interrupt: true,
          message: "Cancelled by operator.",
          toolUseID: input.toolUseID,
        },
        value: "cancel",
      },
    ],
    itemId: input.toolUseID,
    kind: "approval",
    message: input.title ?? input.description ?? `Claude wants to use ${input.tool}: ${detail}`,
    requestId: `claude:${input.sessionId}:${input.toolUseID}`,
    requestKind: inferRequestKind(input.tool),
    turnId: input.sessionId,
  }
}

export function createUserInputRequest(sessionId: string, request: ElicitationRequest): UserInputPrompt | null {
  if (request.mode === "url") {
    return null
  }

  const schema = record(request.requestedSchema)
  const properties = record(schema?.["properties"])
  if (properties === null) {
    return null
  }

  const required = Array.isArray(schema?.["required"])
    ? schema["required"].filter((item): item is string => typeof item === "string")
    : []
  const entries = Object.entries(properties)
    .map(([id, value]) => createQuestion(id, value, request.message, required.includes(id)))
    .filter(
      (entry): entry is { question: UserInputRequest["questions"][number]; schema: Record<string, unknown> } =>
        entry !== null,
    )
  const questions = entries.map((entry) => entry.question)
  if (questions.length === 0) {
    return null
  }

  return {
    fields: Object.fromEntries(entries.map((entry) => [entry.question.id, entry.schema])),
    request: {
      itemId: sessionId,
      kind: "user_input",
      questions,
      requestId: `claude:${sessionId}:question`,
      turnId: sessionId,
    },
  }
}

export function createElicitationRequest(
  sessionId: string,
  request: ElicitationRequest,
): Extract<InteractionRequest, { kind: "elicitation" }> {
  if (request.mode === "url") {
    return {
      elicitationId: request.elicitationId ?? "",
      itemId: null,
      kind: "elicitation",
      message: request.message,
      mode: "url",
      requestId: `claude:${sessionId}:elicitation`,
      serverName: request.serverName,
      turnId: sessionId,
      url: request.url ?? "",
    }
  }

  return {
    itemId: null,
    kind: "elicitation",
    message: request.message,
    mode: "form",
    requestId: `claude:${sessionId}:elicitation`,
    requestedSchema: record(request.requestedSchema) ?? {},
    serverName: request.serverName,
    turnId: sessionId,
  }
}

export function createElicitationResult(
  resolution: Extract<InteractionResolution, { kind: "user_input" }>,
  prompt: UserInputPrompt,
): ElicitationResult {
  return {
    action: "accept",
    content: answersToElicitationContent(resolution, prompt),
  }
}

export function approvalResponse(request: ApprovalRequest, decision: string): PermissionResult {
  const match = request.decisions.find((candidate) => candidate.value === decision)
  const response = match?.response
  if (isPermissionResult(response)) {
    return response
  }

  if (decision === "allow") {
    return { behavior: "allow" }
  }
  if (decision === "deny") {
    return { behavior: "deny", message: "Denied by operator." }
  }

  return { behavior: "deny", interrupt: true, message: "Cancelled by operator." }
}

function inferRequestKind(tool: string): ApprovalRequest["requestKind"] {
  if (tool === "Bash") {
    return "command_execution"
  }
  if (tool === "FileEdit" || tool === "FileWrite" || tool === "NotebookEdit") {
    return "file_change"
  }
  return "permissions"
}

function createQuestion(
  id: string,
  value: unknown,
  fallbackQuestion: string,
  required: boolean,
): { question: UserInputRequest["questions"][number]; schema: Record<string, unknown> } | null {
  const schema = record(value)
  if (schema === null) {
    return null
  }

  const title = typeof schema["title"] === "string" && schema["title"].length > 0 ? schema["title"] : id
  const question =
    typeof schema["description"] === "string" && schema["description"].length > 0
      ? ensureQuestion(schema["description"])
      : ensureQuestion(fallbackQuestion)

  return {
    question: {
      allowEmpty: !required,
      header: title.slice(0, 12),
      id,
      initialValue: defaultValue(schema),
      isOther: false,
      isSecret: false,
      options: parseQuestionOptions(schema),
      preserveWhitespace: true,
      question,
    },
    schema,
  }
}

function parseQuestionOptions(schema: Record<string, unknown>): Array<{ description: string; label: string }> | null {
  const oneOf = Array.isArray(schema["oneOf"]) ? schema["oneOf"] : null
  if (oneOf !== null) {
    const options = oneOf
      .map((item) => {
        const option = record(item)
        if (option === null) {
          return null
        }

        const label = typeof option["title"] === "string" ? option["title"] : scalarLabel(option["const"])
        if (label === null) {
          return null
        }

        return {
          description: "",
          label,
        }
      })
      .filter((item): item is { description: string; label: string } => item !== null)
    return options.length === 0 ? null : options
  }

  const values = Array.isArray(schema["enum"]) ? schema["enum"] : null
  if (values === null) {
    return null
  }

  const options = values
    .map((item) => scalarLabel(item))
    .filter((label): label is string => label !== null)
    .map((label) => ({ description: "", label }))
  return options.length === 0 ? null : options
}

function answersToElicitationContent(
  resolution: Extract<InteractionResolution, { kind: "user_input" }>,
  prompt: UserInputPrompt,
): Record<string, unknown> {
  const content: Record<string, unknown> = {}

  for (const question of prompt.request.questions) {
    const answer = resolution.answers[question.id]?.answers ?? []
    if (answer.length === 0) {
      continue
    }

    content[question.id] = coerceAnswer(prompt.fields[question.id], answer)
  }

  return content
}

function defaultValue(schema: Record<string, unknown>): string | undefined {
  return scalarLabel(schema["default"]) ?? undefined
}

function scalarLabel(value: unknown): string | null {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return null
}

function coerceAnswer(schema: Record<string, unknown> | undefined, answers: string[]): unknown {
  const oneOf = Array.isArray(schema?.["oneOf"]) ? schema["oneOf"] : null
  if (oneOf !== null) {
    const matches = oneOf
      .map((item) => {
        const option = record(item)
        if (option === null) {
          return null
        }

        const label = typeof option["title"] === "string" ? option["title"] : scalarLabel(option["const"])
        if (label === null || !answers.includes(label) || !("const" in option)) {
          return null
        }

        return option["const"]
      })
      .filter((item) => item !== null)
    if (matches.length > 0) {
      return matches.length === 1 ? matches[0] : matches
    }
  }

  const values = Array.isArray(schema?.["enum"]) ? schema["enum"] : null
  if (values !== null) {
    const matches = values.filter((item) => {
      const label = scalarLabel(item)
      return label !== null && answers.includes(label)
    })
    if (matches.length > 0) {
      return matches.length === 1 ? matches[0] : matches
    }
  }

  if (schema?.["type"] === "boolean") {
    return answers[0] === "true"
  }
  if (schema?.["type"] === "integer" || schema?.["type"] === "number") {
    const value = Number(answers[0])
    return Number.isNaN(value) ? answers[0] : value
  }
  if (schema?.["type"] === "array") {
    return answers
  }

  return answers[0]
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

function ensureQuestion(value: string): string {
  const text = value.trim()
  return text.endsWith("?") ? text : `${text}?`
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  return Object.fromEntries(Object.entries(value))
}

function isPermissionResult(value: unknown): value is PermissionResult {
  const result = record(value)
  return result?.["behavior"] === "allow" || result?.["behavior"] === "ask" || result?.["behavior"] === "deny"
}
