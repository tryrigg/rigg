import { defaults, checkValue, type InputDefinition } from "../workflow/input"
import type { WorkflowDocument } from "../workflow/schema"
import { tryParseJson } from "../util/json"

export type InvocationInputNormalizationResult =
  | { kind: "valid"; inputs: Record<string, unknown> }
  | { kind: "invalid"; errors: string[] }

export type OmittedInvocationInput = {
  key: string
  schema: InputDefinition
}

export type ParseInvocationInputEntriesResult =
  | { kind: "valid"; inputs: Record<string, unknown> }
  | { kind: "invalid"; message: string }

function coerceValue(schema: InputDefinition, rawValue: unknown): unknown {
  if (typeof rawValue !== "string" || schema.type === "string") {
    return rawValue
  }

  const parsedValue = tryParseJson(rawValue)
  return parsedValue === undefined || parsedValue === null ? rawValue : parsedValue
}

export function parseEntries(values: string[]): ParseInvocationInputEntriesResult {
  const inputs: Record<string, unknown> = {}

  for (const value of values) {
    const [key, ...rest] = value.split("=")
    if (key === undefined || key.length === 0 || rest.length === 0) {
      return { kind: "invalid", message: `invalid --input \`${value}\`; expected KEY=VALUE` }
    }

    inputs[key] = rest.join("=")
  }

  return { kind: "valid", inputs }
}

export function findOmitted(
  workflow: WorkflowDocument,
  invocationInputs: Record<string, unknown>,
): OmittedInvocationInput[] {
  const omitted: OmittedInvocationInput[] = []

  for (const [key, schema] of Object.entries(workflow.inputs ?? {})) {
    if (key in invocationInputs) {
      continue
    }
    omitted.push({ key, schema })
  }

  return omitted
}

export function mergePrompted(
  invocationInputs: Record<string, unknown>,
  answers: Record<string, string>,
): Record<string, unknown> {
  const merged = { ...invocationInputs }

  for (const [key, rawValue] of Object.entries(answers)) {
    merged[key] = rawValue
  }

  return merged
}

export function normalizeInputs(
  workflow: WorkflowDocument,
  invocationInputs: Record<string, unknown>,
): InvocationInputNormalizationResult {
  const inputs = { ...defaults(workflow.inputs ?? {}), ...invocationInputs }
  const normalizedInputs = { ...inputs }
  const errors: string[] = []

  for (const [key, schema] of Object.entries(workflow.inputs ?? {})) {
    if (!(key in inputs)) {
      if (schema.default === undefined) {
        errors.push(`inputs.${key} is required`)
      }
      continue
    }

    const normalizedValue = coerceValue(schema, inputs[key])
    normalizedInputs[key] = normalizedValue
    errors.push(...checkValue(schema, normalizedValue, `inputs.${key}`))
  }

  for (const key of Object.keys(inputs)) {
    if (!(key in (workflow.inputs ?? {}))) {
      errors.push(`inputs.${key} is not declared`)
    }
  }

  return errors.length > 0 ? { kind: "invalid", errors } : { kind: "valid", inputs: normalizedInputs }
}
