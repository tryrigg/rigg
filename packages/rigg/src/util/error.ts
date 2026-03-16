export function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError"
  }
  if (!(error instanceof Error)) {
    return false
  }

  const code = "code" in error ? error.code : undefined
  return error.name === "AbortError" || code === "ABORT_ERR"
}

export function createAbortError(reason?: unknown): Error {
  if (isAbortError(reason)) {
    return normalizeError(reason)
  }
  if (reason instanceof Error) {
    return new DOMException(reason.message, "AbortError")
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new DOMException(reason, "AbortError")
  }
  return new DOMException("operation aborted", "AbortError")
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
