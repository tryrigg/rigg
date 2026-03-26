export type JsonPrimitive = boolean | null | number | string
export type JsonObject = { [key: string]: JsonValue }
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export type SafeParseJsonResult = { kind: "ok"; value: unknown } | { kind: "invalid" }

export function parseJson(text: string): unknown {
  return JSON.parse(text)
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function compactJson(value: unknown): string {
  return JSON.stringify(value)
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function safeParseJson(text: string): SafeParseJsonResult {
  try {
    return { kind: "ok", value: JSON.parse(text) }
  } catch {
    return { kind: "invalid" }
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
