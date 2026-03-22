import { onAbort } from "../util/abort"
import { createAbortError, normalizeError } from "../util/error"
import { isJsonObject } from "../util/json"
import type { CodexAppServerProcess } from "./proc"

type JsonRpcMessage = Record<string, unknown>
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
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

type ClientState = { kind: "closed" } | { error: Error; kind: "failed" } | { kind: "open" }

type RequestOptions = {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
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

export type CodexRpcClient = {
  close: () => Promise<void>
  notify: (method: string, params?: unknown) => void
  request: (method: string, params?: unknown, options?: RequestOptions) => Promise<unknown>
  respond: (id: string | number, result: unknown) => void
  start: (handlers: RpcHandlers) => void
}

export function createRpcClient(process: CodexAppServerProcess): CodexRpcClient {
  const pending = new Map<string | number, PendingRequest>()
  const ignoredResponses = new Set<string | number>()
  let state: ClientState = { kind: "open" }
  let handlers: RpcHandlers | undefined

  function start(nextHandlers: RpcHandlers): void {
    handlers = nextHandlers

    process.stdout.onLine((line) => {
      void handleStdoutLine(line)
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
        new Error(`codex app-server exited unexpectedly (code=${String(exit.code)} signal=${String(exit.signal)})`),
      )
    })
  }

  async function close(): Promise<void> {
    if (state.kind === "closed") {
      return
    }

    state = { kind: "closed" }
    rejectPending(new Error("codex app-server closed"))
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
      throw new Error("codex app-server RPC client is closed")
    }

    const id = Bun.randomUUIDv7()
    const timeoutMs = options.timeoutMs ?? 30_000
    const message = params === undefined ? { id, method } : { id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      let requestSent = false

      if (options.signal?.aborted) {
        reject(createAbortError(options.signal.reason))
        return
      }

      const abortListener = () => {
        clearTimeout(timeout)
        pending.delete(id)
        if (requestSent) {
          ignoredResponses.add(id)
        }
        reject(createAbortError(options.signal?.reason))
      }
      let disposeAbort = () => {}
      const timeout = setTimeout(() => {
        pending.delete(id)
        if (requestSent) {
          ignoredResponses.add(id)
        }
        disposeAbort()
        reject(new Error(`timed out waiting for codex app-server response to ${method}`))
      }, timeoutMs)

      pending.set(id, {
        dispose: () => disposeAbort(),
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
      await reportFatal(new Error(`received unexpected codex app-server response for id ${String(message.id)}`))
      return
    }

    clearTimeout(pendingRequest.timeout)
    pending.delete(message.id)
    pendingRequest.dispose()
    if (message.error !== undefined) {
      pendingRequest.reject(new Error(message.error.message ?? `codex app-server request ${String(message.id)} failed`))
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
      clearTimeout(pendingRequest.timeout)
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
  }
}

function parseMessage(line: string): ParsedMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return {
      error: new Error(`codex app-server returned invalid JSON: ${line}`, { cause: error }),
      kind: "invalid",
    }
  }

  if (!isJsonObject(parsed)) {
    return {
      error: new Error("codex app-server returned a non-object JSON-RPC message"),
      kind: "invalid",
    }
  }

  if (isResponse(parsed)) {
    return { kind: "response", message: parsed }
  }
  if (isRequest(parsed)) {
    return { kind: "request", message: parsed }
  }
  if (isNotification(parsed)) {
    return { kind: "notification", message: parsed }
  }

  return {
    error: new Error("received codex app-server message in an unsupported JSON-RPC shape"),
    kind: "invalid",
  }
}

function isNotification(value: JsonRpcMessage): value is JsonRpcNotification {
  return typeof value["method"] === "string" && !("id" in value)
}

function isRequest(value: JsonRpcMessage): value is JsonRpcRequest {
  return typeof value["method"] === "string" && (typeof value["id"] === "string" || typeof value["id"] === "number")
}

function isResponse(value: JsonRpcMessage): value is JsonRpcResponse {
  return !("method" in value) && (typeof value["id"] === "string" || typeof value["id"] === "number")
}
