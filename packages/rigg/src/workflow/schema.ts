import { z } from "zod"

import { EffortSchema } from "./effort"
import type { InputDefinition } from "./input"
import { InputSchema } from "./input"

export const StepKind = {
  Branch: "branch",
  Codex: "codex",
  Cursor: "cursor",
  Group: "group",
  Loop: "loop",
  Parallel: "parallel",
  Shell: "shell",
  Workflow: "workflow",
  WriteFile: "write_file",
} as const

export type StepKind = (typeof StepKind)[keyof typeof StepKind]

const EnvSchema = z.record(z.string(), z.string())
const ExportsSchema = z.record(z.string(), z.string())
const ShellWithSchema = z
  .object({
    command: z.string().min(1),
    result: z.enum(["json", "none", "text"]).optional(),
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

const CursorWithSchema = z
  .object({
    mode: z.enum(["agent", "ask", "plan"]).default("agent"),
    model: z.string().min(1).optional(),
    prompt: z.string().min(1),
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

const BaseNodeSchema = z
  .object({
    env: EnvSchema.optional(),
    id: z.string().min(1).optional(),
    if: z.string().min(1).optional(),
    type: z.string().min(1),
  })
  .strict()

type BaseNode = z.infer<typeof BaseNodeSchema>

export type ShellNode = BaseNode & {
  type: "shell"
  with: z.infer<typeof ShellWithSchema>
}

export type CodexNode = BaseNode & {
  type: "codex"
  with: z.infer<typeof CodexTurnWithSchema> | z.infer<typeof CodexReviewWithSchema>
}

export type CursorNode = BaseNode & {
  type: "cursor"
  with: z.infer<typeof CursorWithSchema>
}

export type WriteFileNode = BaseNode & {
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
  max: number
  steps: WorkflowStep[]
  type: "loop"
  until: string
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

export type WorkflowNode = BaseNode & {
  type: "workflow"
  with: WorkflowCallWith
}

export type WorkflowStep =
  | BranchNode
  | CodexNode
  | CursorNode
  | GroupNode
  | LoopNode
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

const ControlBaseSchema = BaseNodeSchema.omit({ type: true })

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

const ShellNodeSchema: z.ZodType<ShellNode> = BaseNodeSchema.extend({
  type: z.literal("shell"),
  with: ShellWithSchema,
}).strict()

const CodexNodeSchema: z.ZodType<CodexNode> = BaseNodeSchema.extend({
  type: z.literal("codex"),
  with: CodexWithSchema,
}).strict()

const CursorNodeSchema: z.ZodType<CursorNode> = BaseNodeSchema.extend({
  type: z.literal("cursor"),
  with: CursorWithSchema,
}).strict()

const WriteFileNodeSchema: z.ZodType<WriteFileNode> = BaseNodeSchema.extend({
  type: z.literal("write_file"),
  with: WriteFileWithSchema,
}).strict()

const WorkflowNodeSchema: z.ZodType<WorkflowNode> = BaseNodeSchema.extend({
  type: z.literal("workflow"),
  with: WorkflowWithSchema,
}).strict()

const GroupNodeSchema: z.ZodType<GroupNode> = z.lazy(() =>
  ControlBaseSchema.extend({
    exports: ExportsSchema.optional(),
    steps: z.array(WorkflowStepSchema).min(1),
    type: z.literal("group"),
  }).strict(),
)

const LoopNodeSchema: z.ZodType<LoopNode> = z.lazy(() =>
  ControlBaseSchema.extend({
    exports: ExportsSchema.optional(),
    max: z.number().int().positive(),
    steps: z.array(WorkflowStepSchema).min(1),
    type: z.literal("loop"),
    until: z.string().min(1),
  }).strict(),
)

const BranchNodeSchema: z.ZodType<BranchNode> = z.lazy(() =>
  ControlBaseSchema.extend({
    cases: z.array(BranchCaseSchema).min(1),
    type: z.literal("branch"),
  }).strict(),
)

const ParallelNodeSchema: z.ZodType<ParallelNode> = z.lazy(() =>
  ControlBaseSchema.extend({
    branches: z.array(ParallelBranchSchema).min(1),
    exports: ExportsSchema.optional(),
    type: z.literal("parallel"),
  }).strict(),
)

export const WorkflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.union([
    ShellNodeSchema,
    CodexNodeSchema,
    CursorNodeSchema,
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

export type ActionNode = CodexNode | CursorNode | ShellNode | WriteFileNode
