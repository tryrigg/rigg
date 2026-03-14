import type { RunReason } from "../history/index"
import { normalizeError } from "../util/error"

export class RunExecutionError extends Error {
  readonly emitRunFailed: boolean
  readonly runReason: RunReason

  constructor(
    message: string,
    options: {
      cause?: unknown
      emitRunFailed?: boolean | undefined
      runReason: RunReason
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "RunExecutionError"
    this.emitRunFailed = options.emitRunFailed ?? true
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

export class ParallelConversationConflictError extends RunExecutionError {
  constructor(name: string, scope: string) {
    super(`parallel branches updated conversation \`${name}\` in \`${scope}\` scope with conflicting handles`, {
      runReason: "step_failed",
    })
    this.name = "ParallelConversationConflictError"
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

export function createEngineError(error: unknown): RunExecutionError {
  const cause = normalizeError(error)
  return new RunExecutionError(cause.message, {
    cause,
    runReason: "engine_error",
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
