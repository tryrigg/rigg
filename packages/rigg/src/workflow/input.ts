import { z } from "zod"

import { asJsonValue, deepEqual, isJsonObject, type JsonValue } from "../util/json"

const JsonSchemaTypeValues = ["string", "integer", "number", "boolean", "object", "array"] as const

export type JsonSchemaType = (typeof JsonSchemaTypeValues)[number]
export const JsonSchemaType = z.enum(JsonSchemaTypeValues)

export type InputDefinition = {
  additionalProperties?: boolean | undefined
  default?: unknown
  description?: string | undefined
  enum?: unknown[] | undefined
  items?: InputDefinition | undefined
  maxItems?: number | undefined
  maxLength?: number | undefined
  maximum?: number | undefined
  minItems?: number | undefined
  minLength?: number | undefined
  minimum?: number | undefined
  pattern?: string | undefined
  properties?: Record<string, InputDefinition> | undefined
  required?: string[] | undefined
  type: JsonSchemaType
}

export type OutputDefinition = {
  additionalProperties?: boolean | undefined
  items?: OutputDefinition | undefined
  nullable?: boolean | undefined
  properties?: Record<string, OutputDefinition> | undefined
  required?: string[] | undefined
  type: JsonSchemaType
}

const allowed: Record<JsonSchemaType, ReadonlySet<keyof InputDefinition>> = {
  array: new Set(["additionalProperties", "default", "description", "enum", "items", "maxItems", "minItems", "type"]),
  boolean: new Set(["default", "description", "enum", "type"]),
  integer: new Set(["default", "description", "enum", "maximum", "minimum", "type"]),
  number: new Set(["default", "description", "enum", "maximum", "minimum", "type"]),
  object: new Set(["additionalProperties", "default", "description", "enum", "properties", "required", "type"]),
  string: new Set(["default", "description", "enum", "maxLength", "minLength", "pattern", "type"]),
}

const review: OutputDefinition = {
  additionalProperties: false,
  properties: {
    findings: {
      items: {
        additionalProperties: false,
        properties: {
          body: { type: "string" },
          code_location: {
            additionalProperties: false,
            properties: {
              absolute_file_path: { type: "string" },
              line_range: {
                additionalProperties: false,
                properties: {
                  end: { type: "integer" },
                  start: { type: "integer" },
                },
                required: ["start", "end"],
                type: "object",
              },
            },
            required: ["absolute_file_path", "line_range"],
            type: "object",
          },
          confidence_score: { type: "number" },
          priority: { nullable: true, type: "integer" },
          title: { type: "string" },
        },
        required: ["title", "body", "confidence_score", "code_location"],
        type: "object",
      },
      type: "array",
    },
    overall_confidence_score: { type: "number" },
    overall_correctness: { type: "string" },
    overall_explanation: { type: "string" },
  },
  required: ["findings", "overall_correctness", "overall_explanation", "overall_confidence_score"],
  type: "object",
}

const base = z
  .object({
    additionalProperties: z.boolean().optional(),
    default: z.unknown().optional(),
    description: z.string().min(1).optional(),
    enum: z.array(z.unknown()).optional(),
    maxItems: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    maximum: z.number().optional(),
    minItems: z.number().int().nonnegative().optional(),
    minLength: z.number().int().nonnegative().optional(),
    minimum: z.number().optional(),
    pattern: z.string().min(1).optional(),
    required: z.array(z.string()).optional(),
  })
  .strict()

export const InputSchema: z.ZodType<InputDefinition> = z.lazy(() =>
  base
    .extend({
      items: InputSchema.optional(),
      properties: z.record(z.string(), InputSchema).optional(),
      type: JsonSchemaType,
    })
    .transform((value) => ({
      additionalProperties: value.additionalProperties,
      default: value.default,
      description: value.description,
      enum: value.enum,
      items: value.items,
      maxItems: value.maxItems,
      maxLength: value.maxLength,
      maximum: value.maximum,
      minItems: value.minItems,
      minLength: value.minLength,
      minimum: value.minimum,
      pattern: value.pattern,
      properties: value.properties,
      required: value.required,
      type: value.type,
    }))
    .superRefine((value, ctx) => {
      checkSchema(value, "input", ctx)
    }),
)

function checkSchema(value: InputDefinition | OutputDefinition, label: "input" | "output", ctx: z.RefinementCtx): void {
  if (value.type === "object" && value.properties === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `object ${label}s require \`properties\`` })
  }
  if (value.type === "array" && value.items === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `array ${label}s require \`items\`` })
  }
}

export function checkDefs(inputs: Record<string, InputDefinition>): string[] {
  const errs: string[] = []
  for (const [key, schema] of Object.entries(inputs)) {
    checkInputDef(schema, `inputs.${key}`, false, errs)
  }
  return errs
}

function checkInputDef(schema: InputDefinition, path: string, nested: boolean, errs: string[]): void {
  checkAllowed(schema, path, allowed[schema.type], errs)
  if (nested && schema.default !== undefined) {
    errs.push(`${path} cannot define nested defaults`)
  }
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
    errs.push(`${path} has minLength greater than maxLength`)
  }
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
    errs.push(`${path} has minItems greater than maxItems`)
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
    errs.push(`${path} has minimum greater than maximum`)
  }
  if (schema.pattern !== undefined) {
    const err = validatePattern(schema.pattern)
    if (err !== undefined) {
      errs.push(`${path}.pattern is not a valid regular expression: ${err}`)
    }
  }
  if (schema.default !== undefined) {
    errs.push(
      ...checkValue(schema, schema.default, path).map(
        (msg) => `${path} has invalid \`default\`: ${trimPath(msg, path)}`,
      ),
    )
  }

  if (schema.type === "object") {
    const props = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!(key in props)) {
        errs.push(`${path}.required references unknown property \`${key}\``)
      }
    }
    for (const [key, prop] of Object.entries(props)) {
      checkInputDef(prop, `${path}.properties.${key}`, true, errs)
    }
  }

  if (schema.type === "array" && schema.items !== undefined) {
    checkInputDef(schema.items, `${path}.items`, true, errs)
  }
}

export function checkValue(schema: InputDefinition, value: unknown, path = "input"): string[] {
  const errs: string[] = []

  if (value === null) {
    return [`${path} must not be null`]
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    return [`${path} must be one of the declared enum values`]
  }

  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") {
        return [`${path} must be a string`]
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errs.push(`${path} must be at least ${schema.minLength} characters`)
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errs.push(`${path} must be at most ${schema.maxLength} characters`)
      }
      const re = schema.pattern === undefined ? undefined : compilePattern(schema.pattern)
      if (re !== undefined && !re.test(value)) {
        errs.push(`${path} must match pattern ${schema.pattern}`)
      }
      return errs
    }
    case "integer":
      if (!isInt(value)) {
        return [`${path} must be an integer`]
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errs.push(`${path} must be >= ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errs.push(`${path} must be <= ${schema.maximum}`)
      }
      return errs
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return [`${path} must be a number`]
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errs.push(`${path} must be >= ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errs.push(`${path} must be <= ${schema.maximum}`)
      }
      return errs
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`]
    case "array":
      if (!Array.isArray(value)) {
        return [`${path} must be an array`]
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errs.push(`${path} must contain at least ${schema.minItems} item(s)`)
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errs.push(`${path} must contain at most ${schema.maxItems} item(s)`)
      }
      if (schema.items !== undefined) {
        for (const [i, item] of value.entries()) {
          errs.push(...checkValue(schema.items, item, `${path}.${i}`))
        }
      }
      return errs
    case "object":
      if (!isJsonObject(value)) {
        return [`${path} must be an object`]
      }

      for (const key of schema.required ?? []) {
        if (!(key in value)) {
          errs.push(`${path}.${key} is required`)
        }
      }
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (key in value) {
          errs.push(...checkValue(prop, value[key], `${path}.${key}`))
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in (schema.properties ?? {}))) {
            errs.push(`${path}.${key} is not allowed`)
          }
        }
      }
      return errs
  }
}

export function defaults(inputs: Record<string, InputDefinition>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(inputs)
      .filter(([, schema]) => schema.default !== undefined)
      .map(([key, schema]) => [key, asJsonValue(schema.default) ?? null] as const),
  )
}

export function reviewOutput(): OutputDefinition {
  return review
}

function checkAllowed<T extends object>(schema: T, path: string, allow: ReadonlySet<keyof T>, errs: string[]): void {
  for (const [key, value] of Object.entries(schema) as Array<[keyof T & string, T[keyof T]]>) {
    if (value !== undefined && !allow.has(key)) {
      errs.push(`${path}.${key} uses an unsupported keyword`)
    }
  }
}

function trimPath(msg: string, path: string): string {
  return msg.startsWith(`${path} `) ? msg.slice(path.length + 1) : msg
}

function validatePattern(pattern: string): string | undefined {
  try {
    void new RegExp(pattern, "u")
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function compilePattern(pattern: string): RegExp | undefined {
  return validatePattern(pattern) === undefined ? new RegExp(pattern, "u") : undefined
}

function isInt(value: unknown): value is number {
  return Number.isInteger(value)
}
