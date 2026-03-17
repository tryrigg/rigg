import { z } from "zod"

export const CodexEffortSchema = z.enum(["low", "medium", "high", "xhigh"])

export type CodexEffort = z.infer<typeof CodexEffortSchema>

export const DEFAULT_CODEX_EFFORT: CodexEffort = "medium"
