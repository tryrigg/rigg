import { randomUUID } from "node:crypto"

import { normalizeError } from "../util/error"
import { isJsonObject } from "../util/json"
import type { CodexAppServerProcess } from "./process"

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
  reject: (error: Error) => void
  resolve: (value: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

type ClientState = { kind: "closed" } | { kind: "failed" } | { kind: "open" }

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
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  respond: (id: string | number, result: unknown) => void
  start: (handlers: RpcHandlers) => void
}

export function createCodexRpcClient(process: CodexAppServerProcess): CodexRpcClient {
  const pending = new Map<string | number, PendingRequest>()
  let state: ClientState = { kind: "open" }
  let handlers: RpcHandlers | undefined

  function start(nextHandlers: RpcHandlers): void {
    handlers = nextHandlers

    process.stdout.on("line", (line) => {
      void handleStdoutLine(line)
    })
    process.child.once("exit", (code, signal) => {
      failPendingRequests(
        new Error(`codex app-server exited unexpectedly (code=${String(code)} signal=${String(signal)})`),
      )
    })
  }

  async function close(): Promise<void> {
    if (state.kind === "closed") {
      return
    }

    failPendingRequests(new Error("codex app-server closed"))
    await process.close()
    state = { kind: "closed" }
  }

  function notify(method: string, params?: unknown): void {
    process.write(params === undefined ? { method } : { method, params })
  }

  function request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (state.kind !== "open") {
      throw new Error("codex app-server RPC client is closed")
    }

    const id = randomUUID()
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timed out waiting for codex app-server response to ${method}`))
      }, timeoutMs)

      pending.set(id, { reject, resolve, timeout })
      process.write(params === undefined ? { id, method } : { id, method, params })
    })
  }

  function respond(id: string | number, result: unknown): void {
    process.write({ id, result })
  }

  async function handleStdoutLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      return
    }

    const parsed = parseMessage(trimmed)
    switch (parsed.kind) {
      case "invalid":
        failPendingRequests(parsed.error)
        return
      case "response":
        handleResponse(parsed.message)
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

  function handleResponse(message: JsonRpcResponse): void {
    const pendingRequest = pending.get(message.id)
    if (pendingRequest === undefined) {
      failPendingRequests(new Error(`received unexpected codex app-server response for id ${String(message.id)}`))
      return
    }

    clearTimeout(pendingRequest.timeout)
    pending.delete(message.id)
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
      await reportError(error)
    }
  }

  async function dispatchNotification(message: JsonRpcNotification): Promise<void> {
    try {
      await handlers?.onNotification(message)
    } catch (error) {
      await reportError(error)
    }
  }

  function failPendingRequests(error: Error): void {
    if (state.kind === "closed") {
      return
    }

    state = { kind: "failed" }
    for (const pendingRequest of pending.values()) {
      clearTimeout(pendingRequest.timeout)
      pendingRequest.reject(error)
    }
    pending.clear()
  }

  async function reportError(error: unknown): Promise<void> {
    const normalized = normalizeError(error)
    failPendingRequests(normalized)
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
