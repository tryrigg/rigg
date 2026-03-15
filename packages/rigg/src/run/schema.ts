import { z } from "zod"

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
export const InteractionKindSchema = z.enum(["approval", "user_input", "elicitation"])
export const BarrierReasonSchema = z.enum([
  "run_started",
  "step_completed",
  "parallel_frontier",
  "loop_iteration_started",
  "branch_selected",
])

export const NodeSnapshotSchema = z.object({
  attempt: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative().optional().nullable(),
  exit_code: z.number().int().optional().nullable(),
  finished_at: z.string().min(1).optional().nullable(),
  node_kind: z.string().min(1),
  node_path: z.string().min(1),
  result: z.unknown().optional().nullable(),
  started_at: z.string().min(1).optional().nullable(),
  status: NodeStatusSchema,
  stderr: z.string().optional().nullable(),
  stdout: z.unknown().optional().nullable(),
  user_id: z.string().min(1).optional().nullable(),
  waiting_for: InteractionKindSchema.optional().nullable(),
})

export const FrontierNodeSchema = z.object({
  action: z.string().optional().nullable(),
  cwd: z.string().optional().nullable(),
  detail: z.string().optional().nullable(),
  frame_id: z.string().min(1),
  model: z.string().optional().nullable(),
  node_kind: z.string().min(1),
  node_path: z.string().min(1),
  prompt_preview: z.string().optional().nullable(),
  user_id: z.string().min(1).optional().nullable(),
})

export const CompletedNodeSummarySchema = z.object({
  node_kind: z.string().min(1),
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
  request: z.unknown(),
  user_id: z.string().min(1).optional().nullable(),
})

export const RunSnapshotSchema = z.object({
  active_barrier: StepBarrierSchema.optional().nullable(),
  active_interaction: PendingInteractionSchema.optional().nullable(),
  active_node_path: z.string().min(1).optional().nullable(),
  finished_at: z.string().min(1).optional().nullable(),
  nodes: z.array(NodeSnapshotSchema),
  phase: RunPhaseSchema,
  reason: RunReasonSchema.optional().nullable(),
  run_id: z.string().min(1),
  started_at: z.string().min(1),
  status: RunStatusSchema,
  workflow_id: z.string().min(1),
})

export type BarrierReason = z.infer<typeof BarrierReasonSchema>
export type CompletedNodeSummary = z.infer<typeof CompletedNodeSummarySchema>
export type FrontierNode = z.infer<typeof FrontierNodeSchema>
export type InteractionKind = z.infer<typeof InteractionKindSchema>
export type NodeSnapshot = z.infer<typeof NodeSnapshotSchema>
export type NodeStatus = z.infer<typeof NodeStatusSchema>
export type PendingInteraction = z.infer<typeof PendingInteractionSchema>
export type RunPhase = z.infer<typeof RunPhaseSchema>
export type RunReason = z.infer<typeof RunReasonSchema>
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>
export type RunStatus = z.infer<typeof RunStatusSchema>
export type StepBarrier = z.infer<typeof StepBarrierSchema>
