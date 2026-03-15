import type { RunReason } from "./schema"
import { normalizeError } from "../util/error"

export class RunExecutionError extends Error {
  readonly runReason: RunReason

  constructor(
    message: string,
    options: {
      cause?: unknown
      runReason: RunReason
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "RunExecutionError"
    this.runReason = options.runReason
  }
}

export class LoopExhaustedError extends RunExecutionError {
  constructor(node: string, maxIterations: number) {
    super(`loop node \`${node}\` exhausted after ${maxIterations} iterations without satisfying \`until\``, {
      runReason: "step_failed",
    })
    this.name = "LoopExhaustedError"
  }
}

export class RunAbortedError extends RunExecutionError {
  constructor(message = "workflow aborted by operator") {
    super(message, {
      runReason: "aborted",
    })
    this.name = "RunAbortedError"
  }
}

export class StepInterruptedError extends Error {
  override readonly cause: unknown

  constructor(message = "step interrupted", options: { cause?: unknown } = {}) {
    super(message)
    this.name = "StepInterruptedError"
    this.cause = options.cause
  }
}

export function createEvaluationError(error: unknown): RunExecutionError {
  const cause = normalizeError(error)
  return new RunExecutionError(cause.message, {
    cause,
    runReason: "evaluation_error",
  })
}

export function createStepFailedError(error: unknown): RunExecutionError {
  const cause = normalizeError(error)
  return new RunExecutionError(cause.message, {
    cause,
    runReason: "step_failed",
  })
}

export function createTimedOutError(error: unknown): RunExecutionError {
  const cause = normalizeError(error)
  return new RunExecutionError(cause.message, {
    cause,
    runReason: "step_timed_out",
  })
}

export function normalizeExecutionError(error: unknown, fallbackReason: RunReason = "engine_error"): RunExecutionError {
  if (error instanceof RunExecutionError) {
    return error
  }

  const cause = normalizeError(error)
  return new RunExecutionError(cause.message, {
    cause,
    runReason: fallbackReason,
  })
}

export function isStepInterrupted(error: unknown): error is StepInterruptedError {
  return error instanceof StepInterruptedError
}
