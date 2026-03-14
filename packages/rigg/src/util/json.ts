import { normalizeError } from "./error"

export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
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

export function stringifyJsonCompact(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    throw normalizeError(error)
  }
}

export function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
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

export function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => asJsonValue(item))
    return items.every((item) => item !== undefined) ? (items as JsonValue[]) : undefined
  }

  if (isJsonObject(value)) {
    const entries = Object.entries(value).map(([key, item]) => [key, asJsonValue(item)] as const)
    if (entries.some(([, item]) => item === undefined)) {
      return undefined
    }

    return Object.fromEntries(entries) as { [key: string]: JsonValue }
  }

  return undefined
}
