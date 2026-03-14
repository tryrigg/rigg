import { describe, expect, test } from "bun:test"

import {
  LoopExhaustedError,
  ParallelConversationConflictError,
  RunExecutionError,
  createEngineError,
  createEvaluationError,
  createStepFailedError,
  createTimedOutError,
  normalizeExecutionError,
} from "../../src/run/error"

describe("run/error", () => {
  test("creates specialized execution errors", () => {
    expect(createEvaluationError(new Error("bad expression"))).toMatchObject({
      message: "bad expression",
      runReason: "evaluation_error",
    })
    expect(createStepFailedError("step failed")).toMatchObject({
      message: "step failed",
      runReason: "step_failed",
    })
    expect(createEngineError(new Error("engine crashed"))).toMatchObject({
      message: "engine crashed",
      runReason: "engine_error",
    })
    expect(createTimedOutError(new Error("timed out"))).toMatchObject({
      message: "timed out",
      runReason: "step_timed_out",
    })
  })

  test("keeps explicit execution errors unchanged", () => {
    const error = new RunExecutionError("known failure", { runReason: "step_failed" })

    expect(normalizeExecutionError(error)).toBe(error)
  })

  test("wraps unknown errors with the fallback reason", () => {
    expect(normalizeExecutionError("boom", "validation_error")).toMatchObject({
      message: "boom",
      runReason: "validation_error",
    })
  })

  test("exposes loop exhaustion and parallel conflict errors", () => {
    expect(new LoopExhaustedError("/0", 5)).toMatchObject({
      message: "loop node `/0` exhausted after 5 iterations without satisfying `until`",
      runReason: "step_failed",
    })
    expect(new ParallelConversationConflictError("review", "workflow")).toMatchObject({
      message: "parallel branches updated conversation `review` in `workflow` scope with conflicting handles",
      runReason: "step_failed",
    })
  })
})
