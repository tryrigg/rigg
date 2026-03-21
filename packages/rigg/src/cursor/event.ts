export type CursorProviderEvent =
  | {
      action: "ask" | "plan" | "run"
      cwd: string
      kind: "session_started"
      provider: "cursor"
      sessionId: string
    }
  | {
      kind: "session_completed"
      provider: "cursor"
      sessionId: string
      status: string
    }
  | {
      kind: "message_delta"
      messageId: string | null
      provider: "cursor"
      sessionId: string
      text: string
    }
  | {
      kind: "diagnostic"
      message: string
      provider: "cursor"
      sessionId?: string | null | undefined
    }
  | {
      kind: "error"
      message: string
      provider: "cursor"
      sessionId?: string | null | undefined
    }
