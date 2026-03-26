import { eq } from "drizzle-orm"

import { tx, type Conn } from "../storage/db"
import type { PendingEvent } from "./batch"
import {
  eventTable,
  type EventInsert,
  type RecordingStatus,
  type RunInsert,
  runTable,
  type StepInsert,
  stepTable,
} from "./history.sql"

type WriteInput = {
  events: PendingEvent[]
  run: RunInsert | null
  runId: string
  seq: number
  steps: StepInsert[]
}

function upsertRun(db: Conn, row: RunInsert): void {
  const updatedAt = Date.now()
  db.insert(runTable)
    .values(row)
    .onConflictDoUpdate({
      set: {
        durationMs: row.durationMs,
        finishedAt: row.finishedAt,
        projectId: row.projectId,
        reason: row.reason,
        recordingStatus: row.recordingStatus,
        startedAt: row.startedAt,
        status: row.status,
        updatedAt,
        workflowId: row.workflowId,
        workspaceId: row.workspaceId,
      },
      target: runTable.id,
    })
    .run()
}

function upsertStep(db: Conn, row: StepInsert): void {
  const updatedAt = Date.now()
  db.insert(stepTable)
    .values(row)
    .onConflictDoUpdate({
      set: {
        attempt: row.attempt,
        durationMs: row.durationMs,
        exitCode: row.exitCode,
        finishedAt: row.finishedAt,
        nodeKind: row.nodeKind,
        payload: row.payload,
        startedAt: row.startedAt,
        status: row.status,
        updatedAt,
        userId: row.userId,
      },
      target: [stepTable.runId, stepTable.nodePath, stepTable.attempt],
    })
    .run()
}

export function writeBatch(db: Conn, input: WriteInput): number {
  const rows: EventInsert[] = input.events.map((event, index) => ({
    ...event,
    runId: input.runId,
    seq: input.seq + index + 1,
  }))

  tx(db, (tx) => {
    if (input.run !== null) {
      upsertRun(tx, input.run)
    }

    for (const step of input.steps) {
      upsertStep(tx, step)
    }

    if (input.events.length === 0) {
      return
    }

    tx.insert(eventTable).values(rows).run()
  })

  return input.seq + rows.length
}

export function updateRecordingStatus(db: Conn, runId: string, recordingStatus: RecordingStatus): void {
  db.update(runTable).set({ recordingStatus, updatedAt: Date.now() }).where(eq(runTable.id, runId)).run()
}
