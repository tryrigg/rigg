export function assertUnreachable(value: never, message = "Unexpected value"): never {
  throw new Error(`${message}: ${String(value)}`)
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
