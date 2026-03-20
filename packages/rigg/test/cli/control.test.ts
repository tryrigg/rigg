import { describe, expect, test } from "bun:test"

import { createRegistry } from "../../src/cli/control"
import { runSnapshot } from "../fixture/builders"

describe("cli/control", () => {
  test("control resolver registry rejects stale requests when the signal aborts", async () => {
    const registry = createRegistry()
    const controller = new AbortController()

    const pending = registry.register({
      barrier: {
        barrier_id: "barrier-1",
        completed: null,
        created_at: "2026-03-15T10:01:00.000Z",
        frame_id: "root",
        next: [],
        reason: "run_started",
      },
      kind: "step_barrier",
      signal: controller.signal,
      snapshot: runSnapshot(),
    })

    controller.abort(new Error("stale barrier"))

    await expect(pending).rejects.toThrow("stale barrier")
  })

  test("control resolver registry preserves aborts that land during listener setup", async () => {
    const registry = createRegistry()
    const controller = new AbortController()
    const originalAddEventListener = AbortSignal.prototype.addEventListener

    AbortSignal.prototype.addEventListener = function (
      this: AbortSignal,
      type: string,
      listener: any,
      options?: AddEventListenerOptions | boolean,
    ): void {
      if (this === controller.signal && type === "abort" && !controller.signal.aborted) {
        controller.abort(new Error("stale barrier"))
      }
      return originalAddEventListener.call(this, type, listener, options)
    }

    try {
      const pending = registry.register({
        barrier: {
          barrier_id: "barrier-1",
          completed: null,
          created_at: "2026-03-15T10:01:00.000Z",
          frame_id: "root",
          next: [],
          reason: "run_started",
        },
        kind: "step_barrier",
        signal: controller.signal,
        snapshot: runSnapshot(),
      })

      await expect(pending).rejects.toThrow("stale barrier")
    } finally {
      AbortSignal.prototype.addEventListener = originalAddEventListener
    }
  })
})
