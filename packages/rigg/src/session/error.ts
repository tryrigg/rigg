import type { RunReason } from "./schema"
import { normalizeError } from "../util/error"

export type RunError = Error & {
  kind: "run_error"
  runReason: RunReason
}

export type StepInterrupt = Error & {
  cause?: unknown
  kind: "step_interrupted"
}

export function runError(message: string, options: { cause?: unknown; runReason: RunReason }): RunError {
  const err = new Error(message, options.cause === undefined ? undefined : { cause: options.cause }) as RunError
  err.name = "RunError"
  err.kind = "run_error"
  err.runReason = options.runReason
  return err
}

export function runAborted(message = "workflow aborted by operator"): RunError {
  return runError(message, { runReason: "aborted" })
}

export function interrupt(message = "step interrupted", options: { cause?: unknown } = {}): StepInterrupt {
  const err = new Error(message) as StepInterrupt
  err.name = "StepInterrupt"
  err.kind = "step_interrupted"
  if (options.cause !== undefined) {
    err.cause = options.cause
  }
  return err
}

export function evalError(error: unknown): RunError {
  const cause = normalizeError(error)
  return runError(cause.message, {
    cause,
    runReason: "evaluation_error",
  })
}

export function stepFailed(error: unknown): RunError {
  const cause = normalizeError(error)
  return runError(cause.message, {
    cause,
    runReason: "step_failed",
  })
}

export function timedOut(error: unknown): RunError {
  const cause = normalizeError(error)
  return runError(cause.message, {
    cause,
    runReason: "step_timed_out",
  })
}

export function isRunError(error: unknown): error is RunError {
  return typeof error === "object" && error !== null && "kind" in error && error.kind === "run_error"
}

export function normalizeExecError(error: unknown, fallbackReason: RunReason = "engine_error"): RunError {
  if (isRunError(error)) {
    return error
  }

  const cause = normalizeError(error)
  return runError(cause.message, {
    cause,
    runReason: fallbackReason,
  })
}

export function isInterrupt(error: unknown): error is StepInterrupt {
  return typeof error === "object" && error !== null && "kind" in error && error.kind === "step_interrupted"
}
