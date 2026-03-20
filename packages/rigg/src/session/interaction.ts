import { z } from "zod"

export const ApprovalDecisionIntentSchema = z.union([
  z.literal("approve"),
  z.literal("cancel"),
  z.literal("deny"),
  z.null(),
])

export const ApprovalDecisionSchema = z.object({
  intent: ApprovalDecisionIntentSchema,
  value: z.string(),
})

const NullableStringSchema = z.string().nullish()

const UserInputQuestionOptionSchema = z.object({
  description: z.string(),
  label: z.string(),
})

const UserInputQuestionSchema = z.object({
  allowEmpty: z.boolean().optional(),
  header: z.string(),
  id: z.string(),
  initialValue: z.string().optional(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(UserInputQuestionOptionSchema).nullable(),
  preserveWhitespace: z.boolean().optional(),
  question: z.string(),
})

export const ApprovalRequestSchema = z.object({
  command: NullableStringSchema,
  cwd: NullableStringSchema,
  decisions: z.array(ApprovalDecisionSchema),
  itemId: z.string(),
  kind: z.literal("approval"),
  message: z.string(),
  requestId: z.string(),
  requestKind: z.enum(["command_execution", "file_change", "permissions"]),
  turnId: z.string(),
})

export const UserInputRequestSchema = z.object({
  itemId: z.string(),
  kind: z.literal("user_input"),
  questions: z.array(UserInputQuestionSchema),
  requestId: z.string(),
  turnId: z.string(),
})

const FormElicitationRequestSchema = z.object({
  itemId: z.null(),
  kind: z.literal("elicitation"),
  message: z.string(),
  mode: z.literal("form"),
  requestId: z.string(),
  requestedSchema: z.record(z.string(), z.unknown()),
  serverName: z.string(),
  turnId: z.string().nullable(),
})

const UrlElicitationRequestSchema = z.object({
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

export const InteractionKindSchema = z.enum(["approval", "user_input", "elicitation"])
export const InteractionRequestSchema = z.union([
  ApprovalRequestSchema,
  UserInputRequestSchema,
  FormElicitationRequestSchema,
  UrlElicitationRequestSchema,
])

export type ApprovalDecisionIntent = z.infer<typeof ApprovalDecisionIntentSchema>
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
export type UserInputQuestion = z.infer<typeof UserInputQuestionSchema>
export type UserInputRequest = z.infer<typeof UserInputRequestSchema>
export type ElicitationRequest = z.infer<typeof FormElicitationRequestSchema | typeof UrlElicitationRequestSchema>
export type InteractionRequest = z.infer<typeof InteractionRequestSchema>

export type ApprovalResolution = {
  decision: string
  kind: "approval"
}

export type UserInputResolution = {
  answers: Record<string, { answers: string[] }>
  kind: "user_input"
}

export type ElicitationResolution = {
  _meta?: unknown
  action: "accept" | "cancel" | "decline"
  content?: unknown
  kind: "elicitation"
}

export type InteractionResolution = ApprovalResolution | UserInputResolution | ElicitationResolution

export type InteractionHandler = (request: InteractionRequest) => Promise<InteractionResolution> | InteractionResolution

export function findDecision(
  request: ApprovalRequest,
  intent: Exclude<ApprovalDecisionIntent, null>,
): ApprovalDecision | undefined {
  return request.decisions.find((decision) => decision.intent === intent)
}

export function inferApprovalDecisionIntent(value: string): ApprovalDecisionIntent {
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
