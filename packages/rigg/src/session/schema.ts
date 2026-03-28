import { z } from "zod"

import { StepKind } from "../workflow/schema"
import { InteractionKindSchema, InteractionRequestSchema } from "./interaction"

export const RunStatusSchema = z.enum(["running", "succeeded", "failed", "aborted"])
export const RunPhaseSchema = z.enum([
  "running",
  "waiting_for_barrier",
  "waiting_for_approval",
  "waiting_for_question",
  "waiting_for_interaction",
  "interrupted",
  "completed",
  "failed",
  "aborted",
])
export const RunReasonSchema = z.enum([
  "completed",
  "aborted",
  "engine_error",
  "evaluation_error",
  "step_failed",
  "step_timed_out",
  "validation_error",
])
export const NodeStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_for_interaction",
  "interrupted",
  "skipped",
  "succeeded",
  "failed",
])
export const BarrierReasonSchema = z.enum([
  "run_started",
  "step_completed",
  "parallel_frontier",
  "loop_iteration_started",
  "branch_selected",
])

export const NodeProgressSchema = z.object({
  current_iteration: z.number().int().nonnegative(),
  max_iterations: z.number().int().positive().nullable(),
})

const NodeKindValues = [...Object.values(StepKind), "branch_case"] as const
export const NodeKindSchema = z.enum(NodeKindValues)

export const NodeSnapshotSchema = z.object({
  attempt: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative().optional().nullable(),
  exit_code: z.number().int().optional().nullable(),
  finished_at: z.string().min(1).optional().nullable(),
  node_kind: NodeKindSchema,
  node_path: z.string().min(1),
  progress: NodeProgressSchema.optional(),
  result: z.unknown().optional().nullable(),
  started_at: z.string().min(1).optional().nullable(),
  status: NodeStatusSchema,
  stderr: z.string().optional().nullable(),
  stdout: z.unknown().optional().nullable(),
  user_id: z.string().min(1).optional().nullable(),
  waiting_for: InteractionKindSchema.optional().nullable(),
})

const BaseFrontierNodeSchema = z.object({
  detail: z.string().optional(),
  frame_id: z.string().min(1),
  node_path: z.string().min(1),
  user_id: z.string().min(1).optional(),
})

export const FrontierNodeSchema = z.discriminatedUnion("node_kind", [
  BaseFrontierNodeSchema.extend({
    node_kind: z.literal("claude"),
    cwd: z.string(),
    model: z.string().optional(),
    prompt_preview: z.string().optional(),
  }).strict(),
  BaseFrontierNodeSchema.extend({
    collaboration_mode: z.enum(["default", "plan"]).optional(),
    cwd: z.string(),
    kind: z.enum(["turn", "review"]),
    model: z.string().optional(),
    node_kind: z.literal("codex"),
    prompt_preview: z.string().optional(),
  }).strict(),
  BaseFrontierNodeSchema.extend({
    cwd: z.string(),
    mode: z.enum(["agent", "ask", "plan"]),
    model: z.string().optional(),
    node_kind: z.literal("cursor"),
    prompt_preview: z.string().optional(),
  }).strict(),
  BaseFrontierNodeSchema.extend({
    agent: z.string().min(1).optional(),
    cwd: z.string(),
    model: z.string().optional(),
    node_kind: z.literal("opencode"),
    permission_mode: z.enum(["default", "auto_approve"]).optional(),
    prompt_preview: z.string().optional(),
    variant: z.string().min(1).optional(),
  }).strict(),
  BaseFrontierNodeSchema.extend({
    node_kind: z.literal("shell"),
  }).strict(),
  BaseFrontierNodeSchema.extend({
    node_kind: z.literal("write_file"),
  }).strict(),
])

export const CompletedNodeSummarySchema = z.object({
  node_kind: NodeKindSchema,
  node_path: z.string().min(1),
  result: z.unknown().optional().nullable(),
  status: NodeStatusSchema,
  user_id: z.string().min(1).optional().nullable(),
})

export const StepBarrierSchema = z.object({
  barrier_id: z.string().min(1),
  completed: CompletedNodeSummarySchema.optional().nullable(),
  created_at: z.string().min(1),
  frame_id: z.string().min(1),
  next: z.array(FrontierNodeSchema),
  reason: BarrierReasonSchema,
})

export const PendingInteractionSchema = z.object({
  created_at: z.string().min(1),
  interaction_id: z.string().min(1),
  kind: InteractionKindSchema,
  node_path: z.string().min(1).optional().nullable(),
  request: InteractionRequestSchema,
  user_id: z.string().min(1).optional().nullable(),
})

export const WaitStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("none"),
  }),
  z.object({
    barrier: StepBarrierSchema,
    kind: z.literal("barrier"),
  }),
  z.object({
    interaction: PendingInteractionSchema,
    kind: z.literal("interaction"),
  }),
])

export const RunSnapshotSchema = z.object({
  finished_at: z.string().min(1).optional().nullable(),
  nodes: z.array(NodeSnapshotSchema),
  phase: RunPhaseSchema,
  reason: RunReasonSchema.optional().nullable(),
  run_id: z.string().min(1),
  started_at: z.string().min(1),
  status: RunStatusSchema,
  waiting: WaitStateSchema,
  workflow_id: z.string().min(1),
})

export type BarrierReason = z.infer<typeof BarrierReasonSchema>
export type CompletedNodeSummary = z.infer<typeof CompletedNodeSummarySchema>
export type FrontierNode = z.infer<typeof FrontierNodeSchema>
export type InteractionKind = z.infer<typeof InteractionKindSchema>
export type NodeKind = z.infer<typeof NodeKindSchema>
export type NodeProgress = z.infer<typeof NodeProgressSchema>
export type NodeSnapshot = z.infer<typeof NodeSnapshotSchema>
export type NodeStatus = z.infer<typeof NodeStatusSchema>
export type PendingInteraction = z.infer<typeof PendingInteractionSchema>
export type RunPhase = z.infer<typeof RunPhaseSchema>
export type RunReason = z.infer<typeof RunReasonSchema>
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>
export type RunStatus = z.infer<typeof RunStatusSchema>
export type StepBarrier = z.infer<typeof StepBarrierSchema>
export type WaitState = z.infer<typeof WaitStateSchema>

export function currentBarrier(snapshot: Pick<RunSnapshot, "waiting">): StepBarrier | null {
  return snapshot.waiting.kind === "barrier" ? snapshot.waiting.barrier : null
}

export function currentInteraction(snapshot: Pick<RunSnapshot, "waiting">): PendingInteraction | null {
  return snapshot.waiting.kind === "interaction" ? snapshot.waiting.interaction : null
}
