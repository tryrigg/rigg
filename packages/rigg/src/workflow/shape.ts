import { deepEqual } from "../util/json"
import type { InputDefinition, JsonSchemaType } from "./input"

export type ResultShape =
  | { kind: "any_json" }
  | { kind: "null" }
  | { kind: "none" }
  | { kind: "string" }
  | { kind: "integer" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "array"; items?: ResultShape | undefined }
  | { kind: "object"; fields: Record<string, ResultShape> }

export const ResultShapeKind = {
  AnyJson: "any_json",
  Array: "array",
  Boolean: "boolean",
  Integer: "integer",
  Null: "null",
  None: "none",
  Number: "number",
  Object: "object",
  String: "string",
} as const

export const AnyJsonShape: ResultShape = { kind: "any_json" }
export const NullShape: ResultShape = { kind: "null" }
export const NoneShape: ResultShape = { kind: "none" }
export const StringShape: ResultShape = { kind: "string" }
export const IntegerShape: ResultShape = { kind: "integer" }
export const NumberShape: ResultShape = { kind: "number" }
export const BooleanShape: ResultShape = { kind: "boolean" }

export function shapeFromJson(value: unknown): ResultShape {
  if (value === null) {
    return NullShape
  }
  if (typeof value === "string") {
    return StringShape
  }
  if (typeof value === "boolean") {
    return BooleanShape
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? IntegerShape : NumberShape
  }
  if (Array.isArray(value)) {
    let items: ResultShape | undefined
    for (const item of value) {
      const next = shapeFromJson(item)
      items = items === undefined ? next : mergeShapes(items, next)
    }
    return items === undefined ? { kind: "array" } : { kind: "array", items }
  }
  if (typeof value === "object" && value !== null) {
    const fields: Record<string, ResultShape> = {}
    for (const [key, item] of Object.entries(value)) {
      fields[key] = shapeFromJson(item)
    }
    return { kind: "object", fields }
  }
  return AnyJsonShape
}

export function mergeShapes(left: ResultShape, right: ResultShape): ResultShape {
  if (left.kind === "any_json" || right.kind === "any_json") {
    return AnyJsonShape
  }
  if (left.kind === "null" || right.kind === "null") {
    return left.kind === right.kind ? left : AnyJsonShape
  }
  if (left.kind === "none" || right.kind === "none") {
    return AnyJsonShape
  }
  if (left.kind === "integer" && right.kind === "number") {
    return NumberShape
  }
  if (left.kind === "number" && right.kind === "integer") {
    return NumberShape
  }
  if (left.kind === right.kind && left.kind !== "array" && left.kind !== "object") {
    return left
  }
  if (left.kind === "array" && right.kind === "array") {
    if (left.items === undefined || right.items === undefined) {
      return { kind: "array" }
    }
    return { kind: "array", items: mergeShapes(left.items, right.items) }
  }
  if (left.kind === "object" && right.kind === "object") {
    const leftKeys = Object.keys(left.fields)
    const rightKeys = Object.keys(right.fields)
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !(key in right.fields))) {
      return AnyJsonShape
    }

    const fields: Record<string, ResultShape> = {}
    for (const key of leftKeys) {
      fields[key] = mergeShapes(left.fields[key] ?? AnyJsonShape, right.fields[key] ?? AnyJsonShape)
    }
    return { kind: "object", fields }
  }
  return AnyJsonShape
}

type SchemaShapeFields = {
  items?: SchemaShapeFields | undefined
  nullable?: boolean | undefined
  properties?: Record<string, SchemaShapeFields> | undefined
  type: JsonSchemaType
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
      return { kind: "array", ...(schema.items === undefined ? {} : { items: shapeFromSchema(schema.items) }) }
    case "object":
      return {
        kind: "object",
        fields: Object.fromEntries(
          Object.entries(schema.properties ?? {}).map(([key, value]) => [key, shapeFromSchema(value)] as const),
        ),
      }
  }
}

export function descendShape(shape: ResultShape, segment: string): ResultShape {
  if (shape.kind === "object") {
    return shape.fields[segment] ?? AnyJsonShape
  }
  if (shape.kind === "array") {
    return shape.items ?? AnyJsonShape
  }
  return AnyJsonShape
}

export function resolveInputPath(
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
      const prop = schema.properties?.[segment]
      if (prop === undefined) {
        return { kind: "error", message: `\`${path}.${segment}\` is not declared` }
      }
      return resolveInputPath(prop, `${path}.${segment}`, rest)
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
      return resolveInputPath(schema.items, `${path}.${segment}`, rest)
    }
  }
}

export function areResultShapesCompatible(left: ResultShape, right: ResultShape): boolean {
  if (deepEqual(left, right)) {
    return true
  }
  if (left.kind === "null" || right.kind === "null") {
    return left.kind === right.kind
  }
  if ((left.kind === "integer" && right.kind === "number") || (left.kind === "number" && right.kind === "integer")) {
    return true
  }
  if (left.kind === "array" && right.kind === "array") {
    if (left.items === undefined || right.items === undefined) {
      return left.items === undefined && right.items === undefined
    }
    return areResultShapesCompatible(left.items, right.items)
  }
  if (left.kind === "object" && right.kind === "object") {
    const leftKeys = Object.keys(left.fields)
    const rightKeys = Object.keys(right.fields)
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !(key in right.fields))) {
      return false
    }
    return leftKeys.every((key) =>
      areResultShapesCompatible(left.fields[key] ?? AnyJsonShape, right.fields[key] ?? AnyJsonShape),
    )
  }
  return false
}

export function validateResultShapePath(stepId: string, shape: ResultShape, segments: string[]): string | undefined {
  if (segments.length === 0) {
    return shape.kind === "none" ? `\`steps.${stepId}.result\` is not available for this node` : undefined
  }

  switch (shape.kind) {
    case "null":
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return `\`steps.${stepId}.result\` does not support nested field access`
    case "none":
      return `\`steps.${stepId}.result\` is not available for this node`
    case "any_json":
      return undefined
    case "object": {
      const [segment, ...rest] = segments
      if (segment === undefined) {
        return undefined
      }
      const child = shape.fields[segment]
      if (child === undefined) {
        return `\`steps.${stepId}.result.${segment}\` is not declared`
      }
      return validateResultShapePath(stepId, child, rest)
    }
    case "array": {
      const [segment, ...rest] = segments
      if (segment === undefined) {
        return undefined
      }
      if (!/^\d+$/.test(segment)) {
        return `\`steps.${stepId}.result\` array access must use a numeric index`
      }
      return shape.items === undefined ? undefined : validateResultShapePath(stepId, shape.items, rest)
    }
  }
}
