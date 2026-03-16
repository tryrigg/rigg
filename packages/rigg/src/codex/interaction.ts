export type CodexApprovalDecisionIntent = "approve" | "cancel" | "deny" | null

export type CodexApprovalDecision = {
  intent: CodexApprovalDecisionIntent
  value: string
}

export type CodexApprovalRequest = {
  command?: string | null | undefined
  cwd?: string | null | undefined
  decisions: ReadonlyArray<CodexApprovalDecision>
  itemId: string
  kind: "approval"
  message: string
  requestId: string
  requestKind: "command_execution" | "file_change" | "permissions"
  turnId: string
}

export type CodexUserInputQuestion = {
  header: string
  id: string
  isOther: boolean
  isSecret: boolean
  options: ReadonlyArray<{
    description: string
    label: string
  }> | null
  question: string
}

export type CodexUserInputRequest = {
  itemId: string
  kind: "user_input"
  questions: ReadonlyArray<CodexUserInputQuestion>
  requestId: string
  turnId: string
}

export type CodexElicitationRequest =
  | {
      itemId: null
      kind: "elicitation"
      message: string
      mode: "form"
      requestId: string
      requestedSchema: Record<string, unknown>
      serverName: string
      turnId: string | null
    }
  | {
      elicitationId: string
      itemId: null
      kind: "elicitation"
      message: string
      mode: "url"
      requestId: string
      serverName: string
      turnId: string | null
      url: string
    }

export type CodexInteractionRequest = CodexApprovalRequest | CodexUserInputRequest | CodexElicitationRequest

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
