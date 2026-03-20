import { describe, expect, test } from "bun:test"

import { isInterrupt } from "../../src/session/error"
import { waitForBarrier } from "../../src/session/barrier"
import { runSnapshot } from "../fixture/builders"

describe("session/barrier", () => {
  test("waitForBarrier preserves aborts that land during abort listener setup", async () => {
    const controller = new AbortController()
    const originalAddEventListener = AbortSignal.prototype.addEventListener

    AbortSignal.prototype.addEventListener = function (
      this: AbortSignal,
      type: string,
      listener: Parameters<AbortSignal["addEventListener"]>[1],
      options?: AddEventListenerOptions | boolean,
    ): void {
      if (this === controller.signal && type === "abort" && !controller.signal.aborted) {
        controller.abort(new Error("control aborted during setup"))
      }
      return originalAddEventListener.call(this, type, listener, options)
    }

    try {
      const environment = {
        controlBroker: {
          enqueue: async <T>(input: { run: (signal: AbortSignal) => Promise<T> }) => await input.run(controller.signal),
        },
        controlHandler: () => new Promise<never>(() => {}),
        emitEvent: () => {},
        runState: runSnapshot(),
      }

      const outcome = await Promise.race([
        waitForBarrier(environment, {
          completed: null,
          frameId: "root",
          next: [],
          reason: "run_started",
        })
          .then(() => "resolved")
          .catch((error) => error),
        new Promise((resolve) => setTimeout(() => resolve("timed_out"), 100)),
      ])

      expect(isInterrupt(outcome)).toBe(true)
      if (!isInterrupt(outcome)) {
        throw new Error(`expected step interrupt, got ${String(outcome)}`)
      }
      expect(outcome.message).toBe("control interrupted")
      expect(outcome.cause).toBeInstanceOf(Error)
    } finally {
      AbortSignal.prototype.addEventListener = originalAddEventListener
    }
  })
})
