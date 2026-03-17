import { z } from "zod"

export const CodexApprovalDecisionIntentSchema = z.union([
  z.literal("approve"),
  z.literal("cancel"),
  z.literal("deny"),
  z.null(),
])

export const CodexApprovalDecisionSchema = z.object({
  intent: CodexApprovalDecisionIntentSchema,
  value: z.string(),
})

const NullableStringSchema = z.string().nullish()

const CodexUserInputQuestionOptionSchema = z.object({
  description: z.string(),
  label: z.string(),
})

const CodexUserInputQuestionSchema = z.object({
  header: z.string(),
  id: z.string(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(CodexUserInputQuestionOptionSchema).nullable(),
  question: z.string(),
})

export const CodexApprovalRequestSchema = z.object({
  command: NullableStringSchema,
  cwd: NullableStringSchema,
  decisions: z.array(CodexApprovalDecisionSchema),
  itemId: z.string(),
  kind: z.literal("approval"),
  message: z.string(),
  requestId: z.string(),
  requestKind: z.enum(["command_execution", "file_change", "permissions"]),
  turnId: z.string(),
})

export const CodexUserInputRequestSchema = z.object({
  itemId: z.string(),
  kind: z.literal("user_input"),
  questions: z.array(CodexUserInputQuestionSchema),
  requestId: z.string(),
  turnId: z.string(),
})

const CodexFormElicitationRequestSchema = z.object({
  itemId: z.null(),
  kind: z.literal("elicitation"),
  message: z.string(),
  mode: z.literal("form"),
  requestId: z.string(),
  requestedSchema: z.record(z.string(), z.unknown()),
  serverName: z.string(),
  turnId: z.string().nullable(),
})

const CodexUrlElicitationRequestSchema = z.object({
  elicitationId: z.string(),
  itemId: z.null(),
  kind: z.literal("elicitation"),
  message: z.string(),
  mode: z.literal("url"),
  requestId: z.string(),
  serverName: z.string(),
  turnId: z.string().nullable(),
  url: z.string(),
})

export const CodexInteractionKindSchema = z.enum(["approval", "user_input", "elicitation"])
export const CodexInteractionRequestSchema = z.union([
  CodexApprovalRequestSchema,
  CodexUserInputRequestSchema,
  CodexFormElicitationRequestSchema,
  CodexUrlElicitationRequestSchema,
])

export type CodexApprovalDecisionIntent = z.infer<typeof CodexApprovalDecisionIntentSchema>
export type CodexApprovalDecision = z.infer<typeof CodexApprovalDecisionSchema>
export type CodexApprovalRequest = z.infer<typeof CodexApprovalRequestSchema>
export type CodexUserInputQuestion = z.infer<typeof CodexUserInputQuestionSchema>
export type CodexUserInputRequest = z.infer<typeof CodexUserInputRequestSchema>
export type CodexElicitationRequest = z.infer<
  typeof CodexFormElicitationRequestSchema | typeof CodexUrlElicitationRequestSchema
>
export type CodexInteractionRequest = z.infer<typeof CodexInteractionRequestSchema>

export type CodexApprovalResolution = {
  decision: string
  kind: "approval"
}

export type CodexUserInputResolution = {
  answers: Record<string, { answers: string[] }>
  kind: "user_input"
}

export type CodexElicitationResolution = {
  _meta?: unknown
  action: "accept" | "cancel" | "decline"
  content?: unknown
  kind: "elicitation"
}

export type CodexInteractionResolution = CodexApprovalResolution | CodexUserInputResolution | CodexElicitationResolution

export type CodexInteractionHandler = (
  request: CodexInteractionRequest,
) => Promise<CodexInteractionResolution> | CodexInteractionResolution

export function findApprovalDecisionByIntent(
  request: CodexApprovalRequest,
  intent: Exclude<CodexApprovalDecisionIntent, null>,
): CodexApprovalDecision | undefined {
  return request.decisions.find((decision) => decision.intent === intent)
}

export function inferApprovalDecisionIntent(value: string): CodexApprovalDecisionIntent {
  const normalized = value.trim().toLowerCase()

  if (normalized === "accept" || normalized === "allow" || normalized === "approve" || normalized === "approved") {
    return "approve"
  }
  if (normalized === "cancel") {
    return "cancel"
  }
  if (normalized === "decline" || normalized === "deny" || normalized === "denied" || normalized === "reject") {
    return "deny"
  }

  return null
}
