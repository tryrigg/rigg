import { EventEmitter } from "node:events"

import { describe, expect, test } from "bun:test"

import { createRpcClient } from "../../../src/provider/cursor/rpc"
import type { CursorAcpProcess } from "../../../src/provider/cursor/proc"
import type { LineSource } from "../../../src/util/line"

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
  exit: (result: {
    code: number | null
    error?: Error | undefined
    expected: boolean
    signal: NodeJS.Signals | null
  }) => void
  process: CursorAcpProcess
  stderr: EventEmitter
  stdout: EventEmitter
  writes: unknown[]
} {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const writes: unknown[] = []
  let resolveExit:
    | ((result: {
        code: number | null
        error?: Error | undefined
        expected: boolean
        signal: NodeJS.Signals | null
      }) => void)
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
      stderr: { done: Promise.resolve(undefined), onLine: stderr.on.bind(stderr, "line") } satisfies LineSource,
      stdout: { done: Promise.resolve(undefined), onLine: stdout.on.bind(stdout, "line") } satisfies LineSource,
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

describe("cursor/rpc", () => {
  test("does not write a request when abort wins during listener setup", async () => {
    const { process, writes } = createFakeProcess()
    const client = createRpcClient(process)

    await expect(
      client.request(
        "session/new",
        { cwd: "/tmp", mode: "agent" },
        { signal: new AbortOnAddSignal("cancelled") as AbortSignal },
      ),
    ).rejects.toMatchObject({
      message: "cancelled",
      name: "AbortError",
    })

    expect(writes).toEqual([])
  })

  test("ignores late responses for requests aborted after being sent", async () => {
    const { process, stdout, writes } = createFakeProcess()
    const client = createRpcClient(process)
    const reportedErrors: Error[] = []

    client.start({
      onError: (error) => {
        reportedErrors.push(error)
      },
      onNotification: () => {},
      onRequest: () => {},
    })

    const controller = new AbortController()
    const requestPromise = client.request("session/new", { cwd: "/tmp", mode: "agent" }, { signal: controller.signal })
    const request = writes[0] as { id: string }

    controller.abort("cancelled")

    await expect(requestPromise).rejects.toMatchObject({
      message: "cancelled",
      name: "AbortError",
    })

    stdout.emit("line", JSON.stringify({ id: request.id, result: { sessionId: "session_1" } }))
    await flushMicrotasks()

    expect(reportedErrors).toEqual([])
  })

  test("keeps the first fatal error when invalid stdout is followed by process exit", async () => {
    const { exit, process, stdout } = createFakeProcess()
    const client = createRpcClient(process)
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
    expect(reportedErrors[0]?.message).toContain("cursor agent acp returned invalid JSON")
  })

  test("processes stdout messages in stream order", async () => {
    const { process, stdout, writes } = createFakeProcess()
    const client = createRpcClient(process)
    let releaseNotification: (() => void) | undefined
    const handled: string[] = []

    client.start({
      onError: () => {},
      onNotification: async (message) => {
        handled.push(`notification:${message.method}`)
        await new Promise<void>((resolve) => {
          releaseNotification = resolve
        })
        handled.push(`notification_done:${message.method}`)
      },
      onRequest: () => {},
    })

    const requestPromise = client.request("session/new", { cwd: "/tmp", mode: "agent" })
    const request = writes[0] as { id: string }

    stdout.emit("line", JSON.stringify({ method: "session/update", params: { sessionId: "session_1" } }))
    stdout.emit("line", JSON.stringify({ id: request.id, result: { sessionId: "session_1" } }))
    await flushMicrotasks()

    let settled = false
    void requestPromise.then(() => {
      settled = true
    })
    await flushMicrotasks()

    expect(handled).toEqual(["notification:session/update"])
    expect(settled).toBe(false)

    releaseNotification?.()
    await expect(requestPromise).resolves.toEqual({ sessionId: "session_1" })
    expect(handled).toEqual(["notification:session/update", "notification_done:session/update"])
  })
})
