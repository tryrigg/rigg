import { z } from "zod"

export const RunStatusSchema = z.enum(["running", "succeeded", "failed"])
export const RunReasonSchema = z.enum([
  "completed",
  "engine_error",
  "evaluation_error",
  "step_failed",
  "step_timed_out",
  "validation_error",
])
export const NodeStatusSchema = z.enum(["pending", "skipped", "succeeded", "failed"])

export const NodeSnapshotSchema = z.object({
  attempt: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative().optional().nullable(),
  exit_code: z.number().int().optional().nullable(),
  finished_at: z.string().min(1).optional().nullable(),
  node_path: z.string().min(1),
  result: z.unknown().optional().nullable(),
  started_at: z.string().min(1).optional().nullable(),
  status: NodeStatusSchema,
  stderr: z.string().optional().nullable(),
  stderr_preview: z.string(),
  stdout: z.unknown().optional().nullable(),
  stdout_preview: z.string(),
  user_id: z.string().min(1).optional().nullable(),
})

export const RunSnapshotSchema = z.object({
  finished_at: z.string().min(1).optional().nullable(),
  nodes: z.array(NodeSnapshotSchema),
  reason: RunReasonSchema.optional().nullable(),
  run_id: z.string().min(1),
  started_at: z.string().min(1),
  status: RunStatusSchema,
  workflow_id: z.string().min(1),
})

export type NodeSnapshot = z.infer<typeof NodeSnapshotSchema>
export type NodeStatus = z.infer<typeof NodeStatusSchema>
export type RunReason = z.infer<typeof RunReasonSchema>
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>
export type RunStatus = z.infer<typeof RunStatusSchema>
