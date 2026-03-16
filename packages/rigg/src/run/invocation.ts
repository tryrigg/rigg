import type { WorkflowDocument } from "../compile/schema"
import { defaultsForInputs, validateInputValue } from "../compile/schema"

export type InvocationInputNormalizationResult =
  | { kind: "valid"; inputs: Record<string, unknown> }
  | { kind: "invalid"; errors: string[] }

export function normalizeInvocationInputs(
  workflow: WorkflowDocument,
  invocationInputs: Record<string, unknown>,
): InvocationInputNormalizationResult {
  const inputs = { ...defaultsForInputs(workflow.inputs ?? {}), ...invocationInputs }
  const errors: string[] = []

  for (const [key, schema] of Object.entries(workflow.inputs ?? {})) {
    if (!(key in inputs)) {
      if (schema.default === undefined) {
        errors.push(`inputs.${key} is required`)
      }
      continue
    }

    errors.push(...validateInputValue(schema, inputs[key], `inputs.${key}`))
  }

  for (const key of Object.keys(inputs)) {
    if (!(key in (workflow.inputs ?? {}))) {
      errors.push(`inputs.${key} is not declared`)
    }
  }

  return errors.length > 0 ? { kind: "invalid", errors } : { kind: "valid", inputs }
}
