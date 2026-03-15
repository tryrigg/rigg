export type CodexProviderEvent =
  | {
      kind: "thread_started"
      provider: "codex"
      threadId: string
    }
  | {
      kind: "turn_started"
      provider: "codex"
      threadId: string
      turnId: string
    }
  | {
      kind: "turn_completed"
      provider: "codex"
      status: string
      threadId: string
      turnId: string
    }
  | {
      itemId: string | null
      kind: "message_delta"
      provider: "codex"
      text: string
      threadId: string
      turnId: string
    }
  | {
      itemId: string | null
      kind: "message_completed"
      provider: "codex"
      text: string
      threadId: string
      turnId: string
    }
  | {
      detail?: string | undefined
      itemId: string | null
      kind: "tool_started"
      provider: "codex"
      threadId: string
      tool: string
      turnId: string
    }
  | {
      detail?: string | undefined
      itemId: string | null
      kind: "tool_completed"
      provider: "codex"
      threadId: string
      tool: string
      turnId: string
    }
  | {
      kind: "error"
      message: string
      provider: "codex"
      threadId?: string | null | undefined
      turnId?: string | null | undefined
    }
  | {
      kind: "diagnostic"
      message: string
      provider: "codex"
    }
