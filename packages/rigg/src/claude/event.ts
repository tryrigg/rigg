export type ClaudeProviderEvent =
  | {
      cwd: string
      kind: "session_started"
      model: string | null
      provider: "claude"
      sessionId: string
    }
  | {
      kind: "session_completed"
      provider: "claude"
      sessionId: string
      status: string
    }
  | {
      kind: "message_delta"
      messageId: string | null
      provider: "claude"
      sessionId: string
      text: string
    }
  | {
      kind: "message_completed"
      messageId: string | null
      provider: "claude"
      sessionId: string
      text: string
    }
  | {
      detail?: string | undefined
      kind: "tool_started"
      provider: "claude"
      sessionId: string
      tool: string
    }
  | {
      detail?: string | undefined
      kind: "tool_completed"
      provider: "claude"
      sessionId: string
      tool: string
    }
  | {
      kind: "diagnostic"
      message: string
      provider: "claude"
      sessionId?: string | null | undefined
    }
  | {
      kind: "error"
      message: string
      provider: "claude"
      sessionId?: string | null | undefined
    }
