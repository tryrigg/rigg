export type OpenCodeProviderEvent =
  | {
      agent: string
      cwd: string
      kind: "session_started"
      model: string | null
      permissionMode: "auto_approve" | "default"
      provider: "opencode"
      sessionId: string
      variant: string | null
    }
  | {
      kind: "session_completed"
      provider: "opencode"
      sessionId: string
      status: string
    }
  | {
      kind: "message_delta"
      messageId: string | null
      partId: string
      provider: "opencode"
      sessionId: string
      text: string
    }
  | {
      kind: "message_completed"
      messageId: string | null
      partId: string
      provider: "opencode"
      sessionId: string
      text: string
    }
  | {
      detail?: string | undefined
      kind: "tool_started"
      provider: "opencode"
      sessionId: string
      tool: string
    }
  | {
      detail?: string | undefined
      kind: "tool_completed"
      provider: "opencode"
      sessionId: string
      tool: string
    }
  | {
      detail?: string | undefined
      kind: "permission_requested"
      message: string
      permissionId: string
      provider: "opencode"
      sessionId: string
      tool: string
    }
  | {
      decision: "always" | "once" | "reject"
      kind: "permission_resolved"
      permissionId: string
      provider: "opencode"
      sessionId: string
      tool: string
    }
  | {
      kind: "diagnostic"
      message: string
      provider: "opencode"
      sessionId?: string | null | undefined
    }
  | {
      kind: "error"
      message: string
      provider: "opencode"
      sessionId?: string | null | undefined
    }
