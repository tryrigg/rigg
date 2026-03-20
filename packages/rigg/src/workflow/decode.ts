import { createDiag, CompileDiagnosticCode, type CompileDiagnostic } from "./diag"
import { checkIdent } from "./id"
import { WorkflowDocumentSchema, type WorkflowDocument } from "./schema"

export type WorkflowDecodeResult =
  | { kind: "decoded"; workflow: WorkflowDocument }
  | { kind: "invalid_workflow"; error: CompileDiagnostic }

export function decode(input: unknown, filePath: string): WorkflowDecodeResult {
  const result = WorkflowDocumentSchema.safeParse(input)
  if (!result.success) {
    const issueSummary = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "<root>"
        return `${path}: ${issue.message}`
      })
      .join("; ")

    return {
      kind: "invalid_workflow",
      error: createDiag(CompileDiagnosticCode.InvalidWorkflow, `Workflow schema validation failed. ${issueSummary}`, {
        filePath,
      }),
    }
  }

  const identifierError = checkIdent(result.data.id, "workflow id", filePath)
  if (identifierError !== undefined) {
    return { kind: "invalid_workflow", error: identifierError }
  }

  return { kind: "decoded", workflow: result.data }
}
