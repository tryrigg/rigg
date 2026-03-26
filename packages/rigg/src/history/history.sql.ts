import { z } from "zod"
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

import { projectTable } from "../project/project.sql"
import { workspaceTable } from "../project/workspace.sql"
import type { InteractionKind, NodeProgress, NodeStatus, RunReason, RunStatus } from "../session/schema"
import { Timestamps } from "../storage/schema.sql"

export const RecordingStatusSchema = z.enum(["complete", "partial", "disabled"])

export type RecordingStatus = z.infer<typeof RecordingStatusSchema>
export type StepPayload = {
  progress?: NodeProgress | null
  result?: unknown
  stderr?: { path: string | null; preview: string | null } | null
  stdout?: { path: string | null; preview: string | null } | null
  waiting_for?: InteractionKind | null
}
export type EventPayload = {
  data?: unknown
  text?: string | null
  user_id?: string | null
}

export const runTable = sqliteTable(
  "run",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    reason: text("reason").$type<RunReason | null>(),
    startedAt: integer("started_at", { mode: "number" }).notNull(),
    finishedAt: integer("finished_at", { mode: "number" }),
    durationMs: integer("duration_ms"),
    recordingStatus: text("recording_status").$type<RecordingStatus>().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("run_workspace_started_idx").on(table.workspaceId, table.startedAt, table.id),
    index("run_project_started_idx").on(table.projectId, table.startedAt, table.id),
    index("run_workspace_workflow_started_idx").on(table.workspaceId, table.workflowId, table.startedAt, table.id),
    index("run_workspace_status_started_idx").on(table.workspaceId, table.status, table.startedAt, table.id),
  ],
)

export const stepTable = sqliteTable(
  "step",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runTable.id, { onDelete: "cascade" }),
    nodePath: text("node_path").notNull(),
    attempt: integer("attempt").notNull(),
    nodeKind: text("node_kind").notNull(),
    userId: text("user_id"),
    status: text("status").$type<NodeStatus>().notNull(),
    startedAt: integer("started_at", { mode: "number" }),
    finishedAt: integer("finished_at", { mode: "number" }),
    durationMs: integer("duration_ms"),
    exitCode: integer("exit_code"),
    payload: text("payload", { mode: "json" }).$type<StepPayload>().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.runId, table.nodePath, table.attempt] })],
)

export const eventTable = sqliteTable(
  "event",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    nodePath: text("node_path"),
    attempt: integer("attempt"),
    kind: text("kind").notNull(),
    stream: text("stream"),
    payload: text("payload", { mode: "json" }).$type<EventPayload>().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    index("event_run_node_attempt_seq_idx").on(table.runId, table.nodePath, table.attempt, table.seq),
  ],
)

export type RunRow = typeof runTable.$inferSelect
export type StepRow = typeof stepTable.$inferSelect
export type EventRow = typeof eventTable.$inferSelect
export type RunInsert = typeof runTable.$inferInsert
export type StepInsert = typeof stepTable.$inferInsert
export type EventInsert = typeof eventTable.$inferInsert
