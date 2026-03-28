import { z } from "zod"

import { EffortSchema } from "./effort"
import type { InputDefinition } from "./input"
import { InputSchema } from "./input"

export const StepKind = {
  Branch: "branch",
  Claude: "claude",
  Codex: "codex",
  Cursor: "cursor",
  Group: "group",
  Loop: "loop",
  OpenCode: "opencode",
  Parallel: "parallel",
  Shell: "shell",
  Workflow: "workflow",
  WriteFile: "write_file",
} as const

export type StepKind = (typeof StepKind)[keyof typeof StepKind]

const EnvSchema = z.record(z.string(), z.string())
const ExportsSchema = z.record(z.string(), z.string())
const ShellStdoutSchema = z
  .object({
    mode: z.enum(["json", "none", "text"]).optional(),
  })
  .strict()
const ShellWithSchema = z
  .object({
    command: z.string().min(1),
    stdout: ShellStdoutSchema.optional(),
  })
  .strict()

const CodexReviewTargetSchema = z.union([
  z.object({ type: z.literal("uncommitted") }).strict(),
  z.object({ branch: z.string().min(1), type: z.literal("base") }).strict(),
  z.object({ sha: z.string().min(1), type: z.literal("commit") }).strict(),
])

const CodexReviewWithSchema = z
  .object({
    kind: z.literal("review"),
    model: z.string().min(1).optional(),
    target: CodexReviewTargetSchema,
  })
  .strict()

const CodexTurnWithSchema = z
  .object({
    collaboration_mode: z.enum(["default", "plan"]).optional(),
    effort: EffortSchema.optional(),
    kind: z.literal("turn"),
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
  })
  .strict()

const CodexWithSchema = z.discriminatedUnion("kind", [CodexTurnWithSchema, CodexReviewWithSchema])

const ClaudePermissionModeSchema = z.enum(["default", "accept_edits", "bypass_permissions", "plan"])
const ClaudeEffortSchema = z.enum(["low", "medium", "high"])
const ClaudeWithSchema = z
  .object({
    effort: ClaudeEffortSchema.optional(),
    max_thinking_tokens: z.number().int().positive().optional(),
    max_turns: z.number().int().positive().optional(),
    model: z.string().min(1).optional(),
    permission_mode: ClaudePermissionModeSchema.optional(),
    prompt: z.string().min(1),
  })
  .strict()

const CursorWithSchema = z
  .object({
    mode: z.enum(["agent", "ask", "plan"]).default("agent"),
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
  })
  .strict()

const OpenCodePermissionModeSchema = z.enum(["default", "auto_approve"])
const OpenCodeWithSchema = z
  .object({
    agent: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permission_mode: OpenCodePermissionModeSchema.optional(),
    prompt: z.string().min(1),
    variant: z.string().min(1).optional(),
  })
  .strict()

const WriteFileWithSchema = z
  .object({
    content: z.string(),
    path: z.string().min(1),
  })
  .strict()

const WorkflowWithSchema = z
  .object({
    inputs: z.record(z.string(), z.unknown()).optional(),
    workflow: z.string().min(1),
  })
  .strict()

const RetryObjectSchema = z
  .object({
    backoff: z.number().positive().optional(),
    delay: z.string().min(1).optional(),
    max: z.number().int().positive(),
  })
  .strict()

export const RetryConfigSchema = z.union([
  z
    .number()
    .int()
    .positive()
    .transform((max) => ({ max })),
  RetryObjectSchema,
])
export type RetryConfig = z.input<typeof RetryConfigSchema>
export type NormalizedRetryConfig = z.output<typeof RetryConfigSchema>

const BaseNodeSchema = z
  .object({
    env: EnvSchema.optional(),
    id: z.string().min(1).optional(),
    if: z.string().min(1).optional(),
    type: z.string().min(1),
  })
  .strict()

type BaseNode = z.infer<typeof BaseNodeSchema>
type RetryableBaseNode = BaseNode & {
  retry?: RetryConfig | undefined
}

export type ShellNode = RetryableBaseNode & {
  type: "shell"
  with: z.infer<typeof ShellWithSchema>
}

export type CodexNode = RetryableBaseNode & {
  type: "codex"
  with: z.infer<typeof CodexTurnWithSchema> | z.infer<typeof CodexReviewWithSchema>
}

export type ClaudeNode = RetryableBaseNode & {
  type: "claude"
  with: z.infer<typeof ClaudeWithSchema>
}

export type CursorNode = RetryableBaseNode & {
  type: "cursor"
  with: z.infer<typeof CursorWithSchema>
}

export type OpenCodeNode = RetryableBaseNode & {
  type: "opencode"
  with: z.infer<typeof OpenCodeWithSchema>
}

export type WriteFileNode = RetryableBaseNode & {
  type: "write_file"
  with: z.infer<typeof WriteFileWithSchema>
}

export type GroupNode = BaseNode & {
  exports?: Record<string, string> | undefined
  steps: WorkflowStep[]
  type: "group"
}

export type LoopNode = BaseNode & {
  exports?: Record<string, string> | undefined
  max?: number | undefined
  steps: WorkflowStep[]
  type: "loop"
  until?: string | undefined
}

export type BranchCase = {
  else?: true | undefined
  exports?: Record<string, string> | undefined
  if?: string | undefined
  steps: WorkflowStep[]
}

export type BranchNode = BaseNode & {
  cases: BranchCase[]
  type: "branch"
}

export type ParallelBranch = {
  id: string
  steps: WorkflowStep[]
}

export type ParallelNode = BaseNode & {
  branches: ParallelBranch[]
  exports?: Record<string, string> | undefined
  type: "parallel"
}

export type WorkflowCallWith = z.infer<typeof WorkflowWithSchema>

export type WorkflowNode = RetryableBaseNode & {
  type: "workflow"
  with: WorkflowCallWith
}

export type WorkflowStep =
  | BranchNode
  | ClaudeNode
  | CodexNode
  | CursorNode
  | GroupNode
  | LoopNode
  | OpenCodeNode
  | ParallelNode
  | ShellNode
  | WorkflowNode
  | WriteFileNode

export type WorkflowDocument = {
  env?: Record<string, string> | undefined
  id: string
  inputs?: Record<string, InputDefinition> | undefined
  steps: WorkflowStep[]
}

const RetryableNodeSchema = BaseNodeSchema.extend({
  retry: RetryConfigSchema.optional(),
}).strict()

const BranchCaseSchema: z.ZodType<BranchCase> = z.lazy(() =>
  z
    .object({
      else: z.preprocess((value) => (value === null ? true : value), z.literal(true).optional()),
      exports: ExportsSchema.optional(),
      if: z.string().min(1).optional(),
      steps: z.array(WorkflowStepSchema),
    })
    .strict(),
)

const ParallelBranchSchema: z.ZodType<ParallelBranch> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      steps: z.array(WorkflowStepSchema).min(1),
    })
    .strict(),
)

const ShellNodeSchema: z.ZodType<ShellNode> = RetryableNodeSchema.extend({
  type: z.literal("shell"),
  with: ShellWithSchema,
}).strict()

const CodexNodeSchema: z.ZodType<CodexNode> = RetryableNodeSchema.extend({
  type: z.literal("codex"),
  with: CodexWithSchema,
}).strict()

const ClaudeNodeSchema: z.ZodType<ClaudeNode> = RetryableNodeSchema.extend({
  type: z.literal("claude"),
  with: ClaudeWithSchema,
}).strict()

const CursorNodeSchema: z.ZodType<CursorNode> = RetryableNodeSchema.extend({
  type: z.literal("cursor"),
  with: CursorWithSchema,
}).strict()

const OpenCodeNodeSchema: z.ZodType<OpenCodeNode> = RetryableNodeSchema.extend({
  type: z.literal("opencode"),
  with: OpenCodeWithSchema,
}).strict()

const WriteFileNodeSchema: z.ZodType<WriteFileNode> = RetryableNodeSchema.extend({
  type: z.literal("write_file"),
  with: WriteFileWithSchema,
}).strict()

const WorkflowNodeSchema: z.ZodType<WorkflowNode> = RetryableNodeSchema.extend({
  type: z.literal("workflow"),
  with: WorkflowWithSchema,
}).strict()

const GroupNodeSchema: z.ZodType<GroupNode> = z.lazy(() =>
  BaseNodeSchema.extend({
    exports: ExportsSchema.optional(),
    steps: z.array(WorkflowStepSchema).min(1),
    type: z.literal("group"),
  }).strict(),
)

const LoopNodeSchema: z.ZodType<LoopNode> = z.lazy(() =>
  BaseNodeSchema.extend({
    exports: ExportsSchema.optional(),
    max: z.number().int().positive().optional(),
    steps: z.array(WorkflowStepSchema).min(1),
    type: z.literal("loop"),
    until: z.string().min(1).optional(),
  })
    .strict()
    .superRefine((step, ctx) => {
      if (step.max !== undefined || step.until !== undefined) {
        return
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`loop` requires at least one termination condition: `max` or `until`",
      })
    }),
)

const BranchNodeSchema: z.ZodType<BranchNode> = z.lazy(() =>
  BaseNodeSchema.extend({
    cases: z.array(BranchCaseSchema).min(1),
    type: z.literal("branch"),
  }).strict(),
)

const ParallelNodeSchema: z.ZodType<ParallelNode> = z.lazy(() =>
  BaseNodeSchema.extend({
    branches: z.array(ParallelBranchSchema).min(1),
    exports: ExportsSchema.optional(),
    type: z.literal("parallel"),
  }).strict(),
)

export const WorkflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.union([
    ShellNodeSchema,
    CodexNodeSchema,
    ClaudeNodeSchema,
    CursorNodeSchema,
    OpenCodeNodeSchema,
    WriteFileNodeSchema,
    WorkflowNodeSchema,
    GroupNodeSchema,
    LoopNodeSchema,
    BranchNodeSchema,
    ParallelNodeSchema,
  ]),
)

export const WorkflowDocumentSchema: z.ZodType<WorkflowDocument> = z
  .object({
    env: EnvSchema.optional(),
    id: z.string().min(1),
    inputs: z.record(z.string(), InputSchema).optional(),
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict()

export type ActionNode = ClaudeNode | CodexNode | CursorNode | OpenCodeNode | ShellNode | WriteFileNode
export type RetryableStep = ActionNode | WorkflowNode

export function isActionStep(step: WorkflowStep): step is ActionNode {
  return (
    step.type === "shell" ||
    step.type === "write_file" ||
    step.type === "claude" ||
    step.type === "codex" ||
    step.type === "cursor" ||
    step.type === "opencode"
  )
}

export function isRetryableStep(step: WorkflowStep): step is RetryableStep {
  return (
    step.type === "shell" ||
    step.type === "write_file" ||
    step.type === "claude" ||
    step.type === "codex" ||
    step.type === "cursor" ||
    step.type === "opencode" ||
    step.type === "workflow"
  )
}
