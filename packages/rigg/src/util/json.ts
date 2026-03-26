import { normalizeError } from "./error"

export type JsonPrimitive = boolean | null | number | string
export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw normalizeError(error)
  }
}

export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    throw normalizeError(error)
  }
}

export function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    throw normalizeError(error)
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function tryParseJson(text: string): unknown {
  try {
    return parseJson(text)
  } catch {
    return undefined
  }
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function stringifyOptional(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === "string") {
    return value
  }
  return compactJson(value)
}

export function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value
  }

  if (Array.isArray(value)) {
    const items: JsonValue[] = []
    for (const item of value) {
      const jsonItem = asJsonValue(item)
      if (jsonItem === undefined) {
        return undefined
      }
      items.push(jsonItem)
    }
    return items
  }

  if (isJsonObject(value)) {
    const output: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      const jsonItem = asJsonValue(item)
      if (jsonItem === undefined) {
        return undefined
      }
      output[key] = jsonItem
    }
    return output
  }

  return undefined
}
