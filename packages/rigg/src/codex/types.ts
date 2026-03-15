export type CodexProviderEvent =
  | {
      detail?: string | undefined
      kind: "tool_use"
      provider: "codex"
      tool: string
    }
  | {
      kind: "status"
      message: string
      provider: "codex"
    }
  | {
      kind: "error"
      message: string
      provider: "codex"
    }
  | {
      kind: "diagnostic"
      message: string
      provider: "codex"
    }

export type CodexApprovalRequest = {
  availableDecisions: readonly string[]
  command?: string | null | undefined
  cwd?: string | null | undefined
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
  decision: "accept" | "cancel" | "decline"
  kind: "approval"
  scope?: "session" | "turn" | undefined
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
