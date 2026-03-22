import { onAbort } from "../util/abort"
import { createAbortError, normalizeError } from "../util/error"
import { isJsonObject } from "../util/json"
import type { CursorAcpProcess } from "./proc"

type JsonRpcNotification = {
  method: string
  params?: unknown
}

type JsonRpcRequest = {
  id: string | number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  error?: { code?: number; message?: string } | undefined
  id: string | number
  result?: unknown
}

type PendingRequest = {
  dispose: () => void
  method: string
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timeout: ReturnType<typeof setTimeout> | null
}

type ClientState = { kind: "closed" } | { error: Error; kind: "failed" } | { kind: "open" }

type RequestOptions = {
  signal?: AbortSignal | undefined
  timeoutMs?: number | null | undefined
}

type RpcHandlers = {
  onError?: ((error: Error) => Promise<void> | void) | undefined
  onNotification: (message: JsonRpcNotification) => Promise<void> | void
  onRequest: (message: JsonRpcRequest) => Promise<void> | void
}

type ParsedMessage =
  | { kind: "invalid"; error: Error }
  | { kind: "notification"; message: JsonRpcNotification }
  | { kind: "request"; message: JsonRpcRequest }
  | { kind: "response"; message: JsonRpcResponse }

export type CursorRpcClient = {
  close: () => Promise<void>
  notify: (method: string, params?: unknown) => void
  request: (method: string, params?: unknown, options?: RequestOptions) => Promise<unknown>
  respond: (id: string | number, result: unknown) => void
  start: (handlers: RpcHandlers) => void
  whenIdle: () => Promise<void>
}

export function createRpcClient(process: CursorAcpProcess): CursorRpcClient {
  const pending = new Map<string | number, PendingRequest>()
  const ignoredResponses = new Set<string | number>()
  let state: ClientState = { kind: "open" }
  let handlers: RpcHandlers | undefined
  let stdoutQueue = Promise.resolve()

  function start(nextHandlers: RpcHandlers): void {
    handlers = nextHandlers

    process.stdout.onLine((line) => {
      stdoutQueue = stdoutQueue.then(
        () => handleStdoutLine(line),
        () => handleStdoutLine(line),
      )
    })
    void process.exited.then((exit) => {
      if (exit.expected) {
        return
      }
      if (exit.error !== undefined) {
        void reportFatal(exit.error)
        return
      }
      void reportFatal(
        new Error(`cursor agent acp exited unexpectedly (code=${String(exit.code)} signal=${String(exit.signal)})`),
      )
    })
  }

  async function close(): Promise<void> {
    if (state.kind === "closed") {
      return
    }

    state = { kind: "closed" }
    rejectPending(new Error("cursor agent acp closed"))
    ignoredResponses.clear()
    await process.close()
  }

  function notify(method: string, params?: unknown): void {
    if (state.kind !== "open") {
      return
    }
    process.write(params === undefined ? { method } : { method, params })
  }

  function request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (state.kind === "failed") {
      throw state.error
    }
    if (state.kind === "closed") {
      throw new Error("cursor agent acp RPC client is closed")
    }

    const id = Bun.randomUUIDv7()
    const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs
    const message = params === undefined ? { id, method } : { id, method, params }

    return new Promise<unknown>((resolve, reject) => {
      let requestSent = false

      if (options.signal?.aborted) {
        reject(createAbortError(options.signal.reason))
        return
      }

      const abortListener = () => {
        if (timeout !== null) {
          clearTimeout(timeout)
        }
        pending.delete(id)
        if (requestSent) {
          ignoredResponses.add(id)
        }
        reject(createAbortError(options.signal?.reason))
      }
      let disposeAbort = () => {}
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              pending.delete(id)
              if (requestSent) {
                ignoredResponses.add(id)
              }
              disposeAbort()
              reject(new Error(`timed out waiting for cursor agent acp response to ${method}`))
            }, timeoutMs)

      pending.set(id, {
        dispose: () => disposeAbort(),
        method,
        reject,
        resolve,
        timeout,
      })
      disposeAbort = onAbort(options.signal, abortListener)
      if (!pending.has(id)) {
        return
      }

      process.write(message)
      requestSent = true
    })
  }

  function respond(id: string | number, result: unknown): void {
    if (state.kind !== "open") {
      return
    }
    process.write({ id, result })
  }

  async function handleStdoutLine(line: string): Promise<void> {
    if (state.kind !== "open") {
      return
    }

    const trimmed = line.trim()
    if (trimmed.length === 0) {
      return
    }

    const parsed = parseMessage(trimmed)
    switch (parsed.kind) {
      case "invalid":
        await reportFatal(parsed.error)
        return
      case "response":
        await handleResponse(parsed.message)
        return
      case "request":
        await dispatchRequest(parsed.message)
        return
      case "notification":
        await dispatchNotification(parsed.message)
        return
      default:
        return parsed satisfies never
    }
  }

  async function handleResponse(message: JsonRpcResponse): Promise<void> {
    const pendingRequest = pending.get(message.id)
    if (pendingRequest === undefined) {
      if (ignoredResponses.delete(message.id)) {
        return
      }
      await reportFatal(new Error(`received unexpected cursor agent acp response for id ${String(message.id)}`))
      return
    }

    if (pendingRequest.timeout !== null) {
      clearTimeout(pendingRequest.timeout)
    }
    pending.delete(message.id)
    pendingRequest.dispose()
    if (message.error !== undefined) {
      const code =
        typeof message.error.code === "number" || typeof message.error.code === "string"
          ? String(message.error.code)
          : "unknown"
      const detail = message.error.message ?? `cursor agent acp request ${String(message.id)} failed`
      pendingRequest.reject(new Error(`cursor agent acp ${pendingRequest.method} failed (code=${code}): ${detail}`))
      return
    }

    pendingRequest.resolve(message.result)
  }

  async function dispatchRequest(message: JsonRpcRequest): Promise<void> {
    try {
      await handlers?.onRequest(message)
    } catch (error) {
      await reportFatal(error)
    }
  }

  async function dispatchNotification(message: JsonRpcNotification): Promise<void> {
    try {
      await handlers?.onNotification(message)
    } catch (error) {
      await reportFatal(error)
    }
  }

  function rejectPending(error: Error): void {
    for (const pendingRequest of pending.values()) {
      if (pendingRequest.timeout !== null) {
        clearTimeout(pendingRequest.timeout)
      }
      pendingRequest.dispose()
      pendingRequest.reject(error)
    }
    pending.clear()
  }

  async function reportFatal(error: unknown): Promise<void> {
    const normalized = normalizeError(error)
    if (state.kind !== "open") {
      return
    }

    state = { error: normalized, kind: "failed" }
    rejectPending(normalized)
    ignoredResponses.clear()
    await handlers?.onError?.(normalized)
  }

  return {
    close,
    notify,
    request,
    respond,
    start,
    whenIdle: () => stdoutQueue,
  }
}

function parseMessage(line: string): ParsedMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return {
      error: new Error(`cursor agent acp returned invalid JSON: ${line}`, { cause: error }),
      kind: "invalid",
    }
  }

  if (!isJsonObject(parsed)) {
    return {
      error: new Error("cursor agent acp returned a non-object JSON-RPC message"),
      kind: "invalid",
    }
  }

  const id = parsed["id"]
  const method = parsed["method"]
  if ((typeof id === "string" || typeof id === "number") && method === undefined) {
    return {
      kind: "response",
      message: {
        error: isJsonObject(parsed["error"]) ? parsed["error"] : undefined,
        id,
        result: parsed["result"],
      },
    }
  }
  if ((typeof id === "string" || typeof id === "number") && typeof method === "string") {
    return {
      kind: "request",
      message: { id, method, params: parsed["params"] },
    }
  }
  if (id === undefined && typeof method === "string") {
    return {
      kind: "notification",
      message: { method, params: parsed["params"] },
    }
  }

  return {
    error: new Error("received cursor agent acp message in an unsupported JSON-RPC shape"),
    kind: "invalid",
  }
}
