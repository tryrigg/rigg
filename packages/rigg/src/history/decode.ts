import { createCompileError, CompileErrorCode } from "../compile/diagnostics"
import { RunSnapshotSchema, type RunSnapshot } from "./schema"

export function decodeRunSnapshot(input: unknown, filePath: string): RunSnapshot {
  const result = RunSnapshotSchema.safeParse(input)
  if (!result.success) {
    throw createCompileError(
      CompileErrorCode.InvalidWorkflow,
      result.error.issues[0]?.message ?? "Invalid run snapshot.",
      { filePath },
    )
  }

  return result.data
}
