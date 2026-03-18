import { EventEmitter } from "node:events"
import type readline from "node:readline"

import { describe, expect, test } from "bun:test"

import { createCodexRpcClient } from "../../src/codex/rpc"
import type { CodexAppServerProcess } from "../../src/codex/process"

class AbortOnAddSignal extends EventTarget {
  aborted = false
  reason: unknown

  constructor(reason: unknown) {
    super()
    this.reason = reason
  }

  override addEventListener(
    type: string,
    listener: Parameters<EventTarget["addEventListener"]>[1],
    options?: Parameters<EventTarget["addEventListener"]>[2],
  ): void {
    super.addEventListener(type, listener, options)
    if (type !== "abort" || this.aborted) {
      return
    }

    this.aborted = true
    super.dispatchEvent(new Event("abort"))
  }
}

function createFakeProcess(): {
  exit: (result: { code: number | null; expected: boolean; signal: NodeJS.Signals | null }) => void
  process: CodexAppServerProcess
  stderr: EventEmitter
  stdout: EventEmitter
  writes: unknown[]
} {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const writes: unknown[] = []
  let resolveExit:
    | ((result: { code: number | null; expected: boolean; signal: NodeJS.Signals | null }) => void)
    | undefined

  return {
    exit: (result) => {
      resolveExit?.(result)
    },
    process: {
      close: async () => {},
      exited: new Promise((resolve) => {
        resolveExit = resolve
      }),
      stderr: stderr as unknown as readline.Interface,
      stdout: stdout as unknown as readline.Interface,
      write: (message) => {
        writes.push(message)
      },
    },
    stderr,
    stdout,
    writes,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("codex/rpc", () => {
  test("does not write a request when abort wins during listener setup", async () => {
    const { process, writes } = createFakeProcess()
    const client = createCodexRpcClient(process)

    await expect(
      client.request("thread/start", { prompt: "hello" }, { signal: new AbortOnAddSignal("cancelled") as AbortSignal }),
    ).rejects.toMatchObject({
      message: "cancelled",
      name: "AbortError",
    })

    expect(writes).toEqual([])
  })

  test("ignores late responses for requests aborted after being sent", async () => {
    const { process, stdout, writes } = createFakeProcess()
    const client = createCodexRpcClient(process)
    const reportedErrors: Error[] = []

    client.start({
      onError: (error) => {
        reportedErrors.push(error)
      },
      onNotification: () => {},
      onRequest: () => {},
    })

    const controller = new AbortController()
    const requestPromise = client.request("thread/start", { prompt: "hello" }, { signal: controller.signal })
    const request = writes[0] as { id: string }

    controller.abort("cancelled")

    await expect(requestPromise).rejects.toMatchObject({
      message: "cancelled",
      name: "AbortError",
    })

    stdout.emit("line", JSON.stringify({ id: request.id, result: { ok: true } }))
    await flushMicrotasks()

    expect(reportedErrors).toEqual([])
  })

  test("keeps the first fatal error when invalid stdout is followed by process exit", async () => {
    const { exit, process, stdout } = createFakeProcess()
    const client = createCodexRpcClient(process)
    const reportedErrors: Error[] = []

    client.start({
      onError: (error) => {
        reportedErrors.push(error)
      },
      onNotification: () => {},
      onRequest: () => {},
    })

    stdout.emit("line", "{not-json")
    exit({ code: 0, expected: false, signal: null })
    await flushMicrotasks()

    expect(reportedErrors).toHaveLength(1)
    expect(reportedErrors[0]?.message).toContain("codex app-server returned invalid JSON")
  })
})
