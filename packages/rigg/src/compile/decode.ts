import { createCompileDiagnostic, CompileDiagnosticCode, type CompileDiagnostic } from "./diagnostic"
import { validateIdentifier, WorkflowDocumentSchema, type WorkflowDocument } from "./schema"

export type WorkflowDecodeResult =
  | { kind: "decoded"; workflow: WorkflowDocument }
  | { kind: "invalid_workflow"; error: CompileDiagnostic }

export function decodeWorkflowFile(input: unknown, filePath: string): WorkflowDecodeResult {
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
      error: createCompileDiagnostic(
        CompileDiagnosticCode.InvalidWorkflow,
        `Workflow schema validation failed. ${issueSummary}`,
        { filePath },
      ),
    }
  }

  const identifierError = validateIdentifier(result.data.id, "workflow id", filePath)
  if (identifierError !== undefined) {
    return { kind: "invalid_workflow", error: identifierError }
  }

  return { kind: "decoded", workflow: result.data }
}
