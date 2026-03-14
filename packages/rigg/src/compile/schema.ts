import { z } from "zod"

import { createCompileError, CompileErrorCode, type CompileError } from "./diagnostics"
import { AnyJsonShape, BooleanShape, IntegerShape, NumberShape, StringShape, type ResultShape } from "./expr"
import { asJsonValue, deepEqual, isJsonObject, type JsonValue } from "../util/json"

export const StepKind = {
  Branch: "branch",
  Claude: "claude",
  Codex: "codex",
  Group: "group",
  Loop: "loop",
  Parallel: "parallel",
  Shell: "shell",
  WriteFile: "write_file",
} as const

export type StepKind = (typeof StepKind)[keyof typeof StepKind]

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/
const JsonSchemaTypeValues = ["string", "integer", "number", "boolean", "object", "array"] as const

export type JsonSchemaType = (typeof JsonSchemaTypeValues)[number]
export const JsonSchemaType = z.enum(JsonSchemaTypeValues)

function isJsonSchemaType(value: unknown): value is JsonSchemaType {
  return typeof value === "string" && JsonSchemaType.safeParse(value).success
}

export function isValidIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value)
}

export function validateIdentifier(value: string, label: string, filePath: string): CompileError | undefined {
  if (!isValidIdentifier(value)) {
    return createCompileError(
      CompileErrorCode.InvalidWorkflow,
      `Invalid ${label} \`${value}\`. Identifiers must start with a letter or \`_\` and only contain ASCII letters, digits, \`_\`, or \`-\`.`,
      { filePath },
    )
  }

  return undefined
}

export type NodePath = string
export type FrameId = string

export function rootNodePath(index: number): NodePath {
  return `/${index}`
}

export function childNodePath(parent: NodePath, index: number): NodePath {
  return `${parent}/${index}`
}

export function compareNodePath(left: NodePath, right: NodePath): number {
  const leftSegments = left.split("/").filter(Boolean)
  const rightSegments = right.split("/").filter(Boolean)
  const length = Math.max(leftSegments.length, rightSegments.length)

  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index]
    const rightSegment = rightSegments[index]

    if (leftSegment === undefined) {
      return -1
    }
    if (rightSegment === undefined) {
      return 1
    }

    const leftNumber = Number.parseInt(leftSegment, 10)
    const rightNumber = Number.parseInt(rightSegment, 10)
    const ordering =
      Number.isNaN(leftNumber) || Number.isNaN(rightNumber)
        ? leftSegment.localeCompare(rightSegment)
        : leftNumber - rightNumber
    if (ordering !== 0) {
      return ordering
    }
  }

  return 0
}

export function nodePathFileComponent(nodePath: NodePath): string {
  return nodePath
    .split("/")
    .filter(Boolean)
    .map((segment) => `s${segment.length.toString(16).padStart(8, "0")}_${segment}`)
    .join("")
}

export function nodePathFromFileComponent(value: string): NodePath | undefined {
  let rest = value
  let path = ""

  while (rest.length > 0) {
    if (!rest.startsWith("s") || rest.length < 10) {
      return undefined
    }

    const length = Number.parseInt(rest.slice(1, 9), 16)
    if (Number.isNaN(length) || rest[9] !== "_") {
      return undefined
    }

    const segment = rest.slice(10, 10 + length)
    if (segment.length !== length) {
      return undefined
    }

    path += `/${segment}`
    rest = rest.slice(10 + length)
  }

  return path.length > 0 ? path : undefined
}

export function rootFrameId(): FrameId {
  return "root"
}

export function childLoopScope(frameId: FrameId, nodePath: NodePath): string {
  return `${frameId}.loop.${nodePathFileComponent(nodePath)}`
}

export function loopIterationFrameId(loopScope: string, iteration: number): FrameId {
  return `${loopScope}.iter.${iteration}`
}

export function parallelBranchFrameId(parentFrameId: FrameId, nodePath: NodePath, branchIndex: number): FrameId {
  return `${parentFrameId}.parallel.${nodePathFileComponent(nodePath)}.branch.${branchIndex}`
}

export function compareFrameId(left: FrameId, right: FrameId): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

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
  nullable?: boolean | undefined
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

const INPUT_ALLOWED_FIELDS: Record<JsonSchemaType, ReadonlySet<keyof InputDefinition>> = {
  array: new Set([
    "additionalProperties",
    "default",
    "description",
    "enum",
    "items",
    "maxItems",
    "minItems",
    "nullable",
    "type",
  ]),
  boolean: new Set(["default", "description", "enum", "nullable", "type"]),
  integer: new Set(["default", "description", "enum", "maximum", "minimum", "nullable", "type"]),
  number: new Set(["default", "description", "enum", "maximum", "minimum", "nullable", "type"]),
  object: new Set([
    "additionalProperties",
    "default",
    "description",
    "enum",
    "nullable",
    "properties",
    "required",
    "type",
  ]),
  string: new Set(["default", "description", "enum", "maxLength", "minLength", "nullable", "pattern", "type"]),
}

const OUTPUT_ALLOWED_FIELDS: Record<JsonSchemaType, ReadonlySet<keyof OutputDefinition>> = {
  array: new Set(["items", "nullable", "type"]),
  boolean: new Set(["nullable", "type"]),
  integer: new Set(["nullable", "type"]),
  number: new Set(["nullable", "type"]),
  object: new Set(["additionalProperties", "nullable", "properties", "required", "type"]),
  string: new Set(["nullable", "type"]),
}

const CODEX_REVIEW_OUTPUT_DEFINITION: OutputDefinition = {
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

function parseJsonSchemaType(input: unknown): {
  type: JsonSchemaType
  nullable: boolean
} {
  if (isJsonSchemaType(input)) {
    return { nullable: false, type: input }
  }

  if (Array.isArray(input) && input.length === 2) {
    const values = new Set(input)
    if (values.has("null")) {
      for (const value of values) {
        if (value !== "null" && isJsonSchemaType(value)) {
          return { nullable: true, type: value }
        }
      }
    }
  }

  throw new Error('type must be a supported JSON schema type or [type, "null"]')
}

const TypeFieldSchema = z.preprocess(
  parseJsonSchemaType,
  z.object({
    nullable: z.boolean(),
    type: JsonSchemaType,
  }),
)

const InputSchemaBase = z
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

const OutputSchemaBase = z
  .object({
    additionalProperties: z.boolean().optional(),
    required: z.array(z.string()).optional(),
  })
  .strict()

export const InputSchema: z.ZodType<InputDefinition> = z.lazy(() =>
  InputSchemaBase.extend({
    items: InputSchema.optional(),
    properties: z.record(z.string(), InputSchema).optional(),
    type: TypeFieldSchema,
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
      nullable: value.type.nullable ? true : undefined,
      pattern: value.pattern,
      properties: value.properties,
      required: value.required,
      type: value.type.type,
    }))
    .superRefine((value, ctx) => {
      validateSchemaStructure(value, "input", ctx)
    }),
)

export const OutputSchema: z.ZodType<OutputDefinition> = z.lazy(() =>
  OutputSchemaBase.extend({
    items: OutputSchema.optional(),
    properties: z.record(z.string(), OutputSchema).optional(),
    type: TypeFieldSchema,
  })
    .transform((value) => ({
      additionalProperties: value.additionalProperties,
      items: value.items,
      nullable: value.type.nullable ? true : undefined,
      properties: value.properties,
      required: value.required,
      type: value.type.type,
    }))
    .superRefine((value, ctx) => {
      validateSchemaStructure(value, "output", ctx)
    }),
)

function validateSchemaStructure(
  value: InputDefinition | OutputDefinition,
  label: "input" | "output",
  ctx: z.RefinementCtx,
): void {
  if (value.type === "object" && value.properties === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `object ${label}s require \`properties\``,
    })
  }
  if (value.type === "array" && value.items === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `array ${label}s require \`items\``,
    })
  }
}

export function validateInputDefinitions(inputs: Record<string, InputDefinition>): string[] {
  const errors: string[] = []
  for (const [key, schema] of Object.entries(inputs)) {
    validateInputDefinition(schema, `inputs.${key}`, false, errors)
  }
  return errors
}

function validateInputDefinition(schema: InputDefinition, path: string, nested: boolean, errors: string[]): void {
  validateAllowedSchemaFields(schema, path, INPUT_ALLOWED_FIELDS[schema.type], errors)
  if (nested && schema.default !== undefined) {
    errors.push(`${path} cannot define nested defaults`)
  }
  if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
    errors.push(`${path} has minLength greater than maxLength`)
  }
  if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
    errors.push(`${path} has minItems greater than maxItems`)
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
    errors.push(`${path} has minimum greater than maximum`)
  }
  if (schema.pattern !== undefined) {
    const patternError = validatePattern(schema.pattern)
    if (patternError !== undefined) {
      errors.push(`${path}.pattern is not a valid regular expression: ${patternError}`)
    }
  }
  if (schema.default !== undefined) {
    errors.push(
      ...validateInputValue(schema, schema.default, path).map(
        (message) => `${path} has invalid \`default\`: ${stripPathPrefix(message, path)}`,
      ),
    )
  }

  if (schema.type === "object") {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!(key in properties)) {
        errors.push(`${path}.required references unknown property \`${key}\``)
      }
    }
    for (const [key, property] of Object.entries(properties)) {
      validateInputDefinition(property, `${path}.properties.${key}`, true, errors)
    }
  }

  if (schema.type === "array" && schema.items !== undefined) {
    validateInputDefinition(schema.items, `${path}.items`, true, errors)
  }
}

export function validateOutputDefinition(schema: OutputDefinition, path: string): string[] {
  const errors: string[] = []
  validateOutputSchema(schema, path, errors)
  return errors
}

function validateOutputSchema(schema: OutputDefinition, path: string, errors: string[]): void {
  validateAllowedSchemaFields(schema, path, OUTPUT_ALLOWED_FIELDS[schema.type], errors)

  if (schema.type === "object") {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!(key in properties)) {
        errors.push(`${path}.required references unknown property \`${key}\``)
      }
    }
    for (const [key, property] of Object.entries(properties)) {
      validateOutputSchema(property, `${path}.properties.${key}`, errors)
    }
  }

  if (schema.type === "array" && schema.items !== undefined) {
    validateOutputSchema(schema.items, `${path}.items`, errors)
  }
}

export function validateInputValue(schema: InputDefinition, value: unknown, path = "input"): string[] {
  const errors: string[] = []

  if (value === null) {
    return schema.nullable ? [] : [`${path} must not be null`]
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    return [`${path} must be one of the declared enum values`]
  }

  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        return [`${path} must be a string`]
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path} must be at least ${schema.minLength} characters`)
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${path} must be at most ${schema.maxLength} characters`)
      }
      const pattern = schema.pattern === undefined ? undefined : compilePattern(schema.pattern)
      if (pattern !== undefined && !pattern.test(value)) {
        errors.push(`${path} must match pattern ${schema.pattern}`)
      }
      return errors
    case "integer":
      if (!isIntegerValue(value)) {
        return [`${path} must be an integer`]
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path} must be >= ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path} must be <= ${schema.maximum}`)
      }
      return errors
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return [`${path} must be a number`]
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path} must be >= ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path} must be <= ${schema.maximum}`)
      }
      return errors
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`]
    case "array":
      if (!Array.isArray(value)) {
        return [`${path} must be an array`]
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path} must contain at least ${schema.minItems} item(s)`)
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path} must contain at most ${schema.maxItems} item(s)`)
      }
      if (schema.items !== undefined) {
        for (const [index, item] of value.entries()) {
          errors.push(...validateInputValue(schema.items, item, `${path}.${index}`))
        }
      }
      return errors
    case "object":
      if (!isJsonObject(value)) {
        return [`${path} must be an object`]
      }
      {
        const properties = schema.properties ?? {}
        for (const key of schema.required ?? []) {
          if (!(key in value)) {
            errors.push(`${path}.${key} is required`)
          }
        }
        for (const [key, propertySchema] of Object.entries(properties)) {
          if (key in value) {
            errors.push(...validateInputValue(propertySchema, value[key], `${path}.${key}`))
          }
        }
        if (schema.additionalProperties === false) {
          for (const key of Object.keys(value)) {
            if (!(key in properties)) {
              errors.push(`${path}.${key} is not allowed`)
            }
          }
        }
      }
      return errors
  }
}

export function validateOutputValue(schema: OutputDefinition, value: unknown, path = "result"): string[] {
  if (value === null) {
    return schema.nullable ? [] : [`${path} must not be null`]
  }

  switch (schema.type) {
    case "string":
      return typeof value === "string" ? [] : [`${path} must be a string`]
    case "integer":
      return Number.isInteger(value) ? [] : [`${path} must be an integer`]
    case "number":
      return typeof value === "number" && !Number.isNaN(value) ? [] : [`${path} must be a number`]
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`]
    case "array":
      if (!Array.isArray(value)) {
        return [`${path} must be an array`]
      }
      {
        const items = schema.items
        return items === undefined
          ? []
          : value.flatMap((item, index) => validateOutputValue(items, item, `${path}.${index}`))
      }
    case "object":
      if (!isJsonObject(value)) {
        return [`${path} must be an object`]
      }
      {
        const errors: string[] = []
        const properties = schema.properties ?? {}
        for (const key of schema.required ?? []) {
          if (!(key in value)) {
            errors.push(`${path}.${key} is required`)
          }
        }
        for (const [key, propertySchema] of Object.entries(properties)) {
          if (key in value) {
            errors.push(...validateOutputValue(propertySchema, value[key], `${path}.${key}`))
          }
        }
        if (schema.additionalProperties === false) {
          for (const key of Object.keys(value)) {
            if (!(key in properties)) {
              errors.push(`${path}.${key} is not allowed`)
            }
          }
        }
        return errors
      }
  }
}

export function defaultsForInputs(inputs: Record<string, InputDefinition>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(inputs)
      .filter(([, schema]) => schema.default !== undefined)
      .map(([key, schema]) => [key, asJsonValue(schema.default) ?? null] as const),
  )
}

type SchemaShapeFields = {
  type: JsonSchemaType
  nullable?: boolean | undefined
  items?: SchemaShapeFields | undefined
  properties?: Record<string, SchemaShapeFields> | undefined
}

export function shapeFromSchema(schema: SchemaShapeFields): ResultShape {
  switch (schema.type) {
    case "string":
      return schema.nullable ? AnyJsonShape : StringShape
    case "integer":
      return schema.nullable ? AnyJsonShape : IntegerShape
    case "number":
      return schema.nullable ? AnyJsonShape : NumberShape
    case "boolean":
      return schema.nullable ? AnyJsonShape : BooleanShape
    case "array":
      return {
        kind: "array",
        ...(schema.items === undefined ? {} : { items: shapeFromSchema(schema.items) }),
      }
    case "object":
      return {
        kind: "object",
        fields: Object.fromEntries(
          Object.entries(schema.properties ?? {}).map(([key, value]) => [key, shapeFromSchema(value)] as const),
        ),
      }
  }
}

export function resolveInputPathShape(
  schema: InputDefinition,
  path: string,
  segments: string[],
): { kind: "ok"; shape: ResultShape } | { kind: "error"; message: string } {
  if (segments.length === 0) {
    return { kind: "ok", shape: shapeFromSchema(schema) }
  }

  switch (schema.type) {
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return { kind: "error", message: `\`${path}\` does not support nested field access` }
    case "object": {
      const [segment, ...rest] = segments
      if (segment === undefined) {
        return { kind: "ok", shape: shapeFromSchema(schema) }
      }
      const property = schema.properties?.[segment]
      if (property === undefined) {
        return { kind: "error", message: `\`${path}.${segment}\` is not declared` }
      }
      return resolveInputPathShape(property, `${path}.${segment}`, rest)
    }
    case "array": {
      const [segment, ...rest] = segments
      if (segment === undefined) {
        return { kind: "ok", shape: shapeFromSchema(schema) }
      }
      if (!/^\d+$/.test(segment)) {
        return { kind: "error", message: `\`${path}\` array access must use a numeric index` }
      }
      if (schema.items === undefined) {
        return { kind: "ok", shape: AnyJsonShape }
      }
      return resolveInputPathShape(schema.items, `${path}.${segment}`, rest)
    }
  }
}

export function canonicalizeOutputSchema(schema: OutputDefinition): unknown {
  const type = schema.nullable ? [schema.type, "null"] : schema.type
  switch (schema.type) {
    case "object":
      return {
        additionalProperties: schema.additionalProperties ?? false,
        properties: Object.fromEntries(
          Object.entries(schema.properties ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => [key, canonicalizeOutputSchema(value)] as const),
        ),
        required: [...(schema.required ?? [])].sort(),
        type,
      }
    case "array":
      return {
        ...(schema.items === undefined ? {} : { items: canonicalizeOutputSchema(schema.items) }),
        type,
      }
    default:
      return { type }
  }
}

export function codexReviewOutputDefinition(): OutputDefinition {
  return CODEX_REVIEW_OUTPUT_DEFINITION
}

const EnvSchema = z.record(z.string(), z.string())
const ExportsSchema = z.record(z.string(), z.string())
const ConversationSchema = z
  .object({
    name: z.string().min(1),
    scope: z.enum(["iteration", "loop", "workflow"]).optional(),
  })
  .strict()

const ShellWithSchema = z
  .object({
    command: z.string().min(1),
    result: z.enum(["json", "none", "text"]).optional(),
  })
  .strict()

const CodexReviewWithSchema = z
  .object({
    action: z.literal("review"),
    add_dirs: z.array(z.string().min(1)).optional(),
    base: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
    mode: z.enum(["default", "full_auto"]).optional(),
    model: z.string().min(1).optional(),
    persist: z.boolean().optional(),
    prompt: z.string().min(1).optional(),
    target: z.enum(["base", "commit", "uncommitted"]).optional(),
    title: z.string().min(1).optional(),
  })
  .strict()

const CodexExecWithSchema = z
  .object({
    action: z.literal("exec"),
    add_dirs: z.array(z.string().min(1)).optional(),
    conversation: ConversationSchema.optional(),
    mode: z.enum(["default", "full_auto"]).optional(),
    model: z.string().min(1).optional(),
    output_schema: OutputSchema.optional(),
    persist: z.boolean().optional(),
    prompt: z.string().min(1),
  })
  .strict()

const ClaudeWithSchema = z
  .object({
    action: z.literal("prompt"),
    add_dirs: z.array(z.string().min(1)).optional(),
    conversation: ConversationSchema.optional(),
    model: z.string().min(1).optional(),
    output_schema: OutputSchema.optional(),
    permission_mode: z.enum(["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan"]).optional(),
    persist: z.boolean().optional(),
    prompt: z.string().min(1),
  })
  .strict()

const WriteFileWithSchema = z
  .object({
    content: z.string(),
    path: z.string().min(1),
  })
  .strict()

const BaseNodeSchema = z
  .object({
    env: EnvSchema.optional(),
    id: z.string().min(1).optional(),
    if: z.string().min(1).optional(),
    type: z.string().min(1),
  })
  .strict()

type BaseNode = z.infer<typeof BaseNodeSchema>

export type ShellNode = BaseNode & {
  type: "shell"
  with: z.infer<typeof ShellWithSchema>
}

export type CodexNode = BaseNode & {
  type: "codex"
  with: z.infer<typeof CodexReviewWithSchema> | z.infer<typeof CodexExecWithSchema>
}

export type ClaudeNode = BaseNode & {
  type: "claude"
  with: z.infer<typeof ClaudeWithSchema>
}

export type WriteFileNode = BaseNode & {
  type: "write_file"
  with: z.infer<typeof WriteFileWithSchema>
}

export type GroupNode = BaseNode & {
  exports?: Record<string, string> | undefined
  steps: WorkflowStep[]
  type: "group"
}

export type LoopNode = BaseNode & {
  exports?: Record<string, string> | undefined
  max: number
  steps: WorkflowStep[]
  type: "loop"
  until: string
}

export type BranchCase = {
  else?: true | undefined
  exports?: Record<string, string> | undefined
  if?: string | undefined
  steps: WorkflowStep[]
}

export type BranchNode = BaseNode & {
  cases: BranchCase[]
  type: "branch"
}

export type ParallelBranch = {
  id: string
  steps: WorkflowStep[]
}

export type ParallelNode = BaseNode & {
  branches: ParallelBranch[]
  exports?: Record<string, string> | undefined
  type: "parallel"
}

export type WorkflowStep =
  | BranchNode
  | ClaudeNode
  | CodexNode
  | GroupNode
  | LoopNode
  | ParallelNode
  | ShellNode
  | WriteFileNode

export type WorkflowDocument = {
  env?: Record<string, string> | undefined
  id: string
  inputs?: Record<string, InputDefinition> | undefined
  steps: WorkflowStep[]
}

const ControlBaseSchema = BaseNodeSchema.omit({ type: true })

const BranchCaseSchema: z.ZodType<BranchCase> = z.lazy(() =>
  z
    .object({
      else: z.preprocess((value) => (value === null ? true : value), z.literal(true).optional()),
      exports: ExportsSchema.optional(),
      if: z.string().min(1).optional(),
      steps: z.array(WorkflowStepSchema),
    })
    .strict(),
)

const ParallelBranchSchema: z.ZodType<ParallelBranch> = z.lazy(() =>
  z
    .object({
      id: z.string().min(1),
      steps: z.array(WorkflowStepSchema).min(1),
    })
    .strict(),
)

const ShellNodeSchema: z.ZodType<ShellNode> = BaseNodeSchema.extend({
  type: z.literal("shell"),
  with: ShellWithSchema,
}).strict()

const CodexNodeSchema: z.ZodType<CodexNode> = BaseNodeSchema.extend({
  type: z.literal("codex"),
  with: z.union([CodexReviewWithSchema, CodexExecWithSchema]),
}).strict()

const ClaudeNodeSchema: z.ZodType<ClaudeNode> = BaseNodeSchema.extend({
  type: z.literal("claude"),
  with: ClaudeWithSchema,
}).strict()

const WriteFileNodeSchema: z.ZodType<WriteFileNode> = BaseNodeSchema.extend({
  type: z.literal("write_file"),
  with: WriteFileWithSchema,
}).strict()

const GroupNodeSchema: z.ZodType<GroupNode> = z.lazy(() =>
  ControlBaseSchema.extend({
    exports: ExportsSchema.optional(),
    steps: z.array(WorkflowStepSchema).min(1),
    type: z.literal("group"),
  }).strict(),
)

const LoopNodeSchema: z.ZodType<LoopNode> = z.lazy(() =>
  ControlBaseSchema.extend({
    exports: ExportsSchema.optional(),
    max: z.number().int().positive(),
    steps: z.array(WorkflowStepSchema).min(1),
    type: z.literal("loop"),
    until: z.string().min(1),
  }).strict(),
)

const BranchNodeSchema: z.ZodType<BranchNode> = z.lazy(() =>
  ControlBaseSchema.extend({
    cases: z.array(BranchCaseSchema).min(1),
    type: z.literal("branch"),
  }).strict(),
)

const ParallelNodeSchema: z.ZodType<ParallelNode> = z.lazy(() =>
  ControlBaseSchema.extend({
    branches: z.array(ParallelBranchSchema).min(1),
    exports: ExportsSchema.optional(),
    type: z.literal("parallel"),
  }).strict(),
)

export const WorkflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.union([
    ShellNodeSchema,
    CodexNodeSchema,
    ClaudeNodeSchema,
    WriteFileNodeSchema,
    GroupNodeSchema,
    LoopNodeSchema,
    BranchNodeSchema,
    ParallelNodeSchema,
  ]),
)

export const WorkflowDocumentSchema: z.ZodType<WorkflowDocument> = z
  .object({
    env: EnvSchema.optional(),
    id: z.string().min(1),
    inputs: z.record(z.string(), InputSchema).optional(),
    steps: z.array(WorkflowStepSchema).min(1),
  })
  .strict()

export type ActionNode = ClaudeNode | CodexNode | ShellNode | WriteFileNode
export type StructuredOutput = OutputDefinition

function validateAllowedSchemaFields<T extends object>(
  schema: T,
  path: string,
  allowed: ReadonlySet<keyof T>,
  errors: string[],
): void {
  for (const [key, value] of Object.entries(schema) as Array<[keyof T & string, T[keyof T]]>) {
    if (value !== undefined && !allowed.has(key)) {
      errors.push(`${path}.${key} uses an unsupported keyword`)
    }
  }
}

function stripPathPrefix(message: string, path: string): string {
  return message.startsWith(`${path} `) ? message.slice(path.length + 1) : message
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

function isIntegerValue(value: unknown): value is number {
  return Number.isInteger(value)
}
