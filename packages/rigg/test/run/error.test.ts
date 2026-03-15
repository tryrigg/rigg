import { describe, expect, test } from "bun:test"

import {
  LoopExhaustedError,
  RunExecutionError,
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

  test("exposes loop exhaustion errors", () => {
    expect(new LoopExhaustedError("/0", 5)).toMatchObject({
      message: "loop node `/0` exhausted after 5 iterations without satisfying `until`",
      runReason: "step_failed",
    })
  })
})
