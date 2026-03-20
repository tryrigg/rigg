import { describe, expect, test } from "bun:test"

import {
  evalError,
  isRunError,
  loopExhausted,
  normalizeExecError,
  runError,
  stepFailed,
  timedOut,
} from "../../src/session/error"

describe("session/error", () => {
  test("creates specialized execution errors", () => {
    expect(evalError(new Error("bad expression"))).toMatchObject({
      message: "bad expression",
      runReason: "evaluation_error",
    })
    expect(stepFailed("step failed")).toMatchObject({
      message: "step failed",
      runReason: "step_failed",
    })
    expect(timedOut(new Error("timed out"))).toMatchObject({
      message: "timed out",
      runReason: "step_timed_out",
    })
  })

  test("keeps explicit execution errors unchanged", () => {
    const error = runError("known failure", { runReason: "step_failed" })

    expect(normalizeExecError(error)).toBe(error)
    expect(isRunError(error)).toBe(true)
  })

  test("wraps unknown errors with the fallback reason", () => {
    expect(normalizeExecError("boom", "validation_error")).toMatchObject({
      message: "boom",
      runReason: "validation_error",
    })
  })

  test("exposes loop exhaustion errors", () => {
    expect(loopExhausted("/0", 5)).toMatchObject({
      message: "loop node `/0` exhausted after 5 iterations without satisfying `until`",
      runReason: "step_failed",
    })
  })
})
