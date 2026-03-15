import type { OutputDefinition } from "../compile/schema"
import { validateOutputValue } from "../compile/schema"
import { createStepFailedError } from "../run/error"
import { parseJson, stringifyJson } from "../util/json"
import {
  startCodexAppServer,
  assertSupportedCodexVersion,
  isBenignCodexDiagnostic,
  type CodexProcessOptions,
} from "./process"
import { createCodexRpcClient } from "./rpc"
import type {
  CodexInteractionHandler,
  CodexInteractionRequest,
  CodexInteractionResolution,
  CodexProviderEvent,
  CodexReviewResult,
} from "./types"

type CodexRuntimeOptions = CodexProcessOptions & {
  interactionHandler?: CodexInteractionHandler | undefined
  onEvent?: ((event: CodexProviderEvent) => Promise<void> | void) | undefined
}

type InitializeParams = {
  capabilities: null
  clientInfo: {
    name: string
    title: string
    version: string
  }
}

type ThreadStartParams = {
  cwd: string
  experimentalRawEvents: boolean
  model: string | null
  persistExtendedHistory: boolean
}

type TurnStartParams = {
  input: Array<{
    text: string
    text_elements: []
    type: "text"
  }>
  model: string | null
  outputSchema: null
  threadId: string
}

type ReviewStartTarget =
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "uncommittedChanges" }

type ReviewStartParams = {
  target: ReviewStartTarget
  threadId: string
}

type TurnInterruptParams = {
  threadId: string
  turnId: string
}

type StepCapture = {
  diagnostics: string[]
  providerEvents: CodexProviderEvent[]
}

type TurnMethod = "review/start" | "turn/start"

type ThreadTarget =
  | { type: "base"; value: string }
  | { type: "commit"; title?: string | undefined; value: string }
  | { type: "uncommitted" }

type TurnExecution = {
  assistantMessages: string[]
  diagnostics: string[]
  errorMessage: string | null
  interrupted: boolean
  providerEvents: CodexProviderEvent[]
  reject: (error: Error) => void
  resolve: (value: TurnResult) => void
  reviewText: string | null
  threadId: string
  turnId: string
}

type TurnResult = {
  diagnostics: string[]
  errorMessage: string | null
  interrupted: boolean
  providerEvents: CodexProviderEvent[]
  reviewText: string | null
  status: string
  text: string
}

const REVIEW_BULLET_PATTERN = /^- (?:\[[x ]\] )?(.+?) — (.+:\d+-\d+)$/

const SOFT_NOTIFICATION_METHODS = new Set([
  "account/updated",
  "account/rateLimits/updated",
  "app/list/updated",
  "configWarning",
  "deprecationNotice",
  "fuzzyFileSearch/sessionCompleted",
  "fuzzyFileSearch/sessionUpdated",
  "hook/completed",
  "hook/started",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "model/rerouted",
  "rawResponseItem/completed",
  "serverRequest/resolved",
  "skills/changed",
  "thread/archived",
  "thread/closed",
  "thread/compacted",
  "thread/name/updated",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/itemAdded",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/unarchived",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
])

export type CodexStepResult = {
  exitCode: number
  providerEvents: CodexProviderEvent[]
  result: unknown
  stderr: string
  stdout: string
}

export type CodexRuntimeSession = {
  close: () => Promise<void>
  interruptActiveTurn: () => Promise<void>
  review: (options: { cwd: string; model?: string | undefined; target: ThreadTarget }) => Promise<CodexStepResult>
  run: (options: {
    cwd: string
    model?: string | undefined
    outputSchema?: OutputDefinition | undefined
    prompt: string
  }) => Promise<CodexStepResult>
}

export async function createCodexRuntimeSession(options: CodexRuntimeOptions): Promise<CodexRuntimeSession> {
  assertSupportedCodexVersion(options)

  const appServer = startCodexAppServer(options)
  const rpc = createCodexRpcClient(appServer)
  let activeTurn: TurnExecution | undefined
  let closed = false
  let stepCapture: StepCapture | undefined
  const sigintHandler = () => {
    void interruptActiveTurn()
  }

  async function emit(event: CodexProviderEvent): Promise<void> {
    if (stepCapture?.providerEvents !== activeTurn?.providerEvents) {
      stepCapture?.providerEvents.push(event)
    }
    activeTurn?.providerEvents.push(event)
    await options.onEvent?.(event)
  }

  function createStepCapture(): StepCapture {
    return {
      diagnostics: [],
      providerEvents: [],
    }
  }

  function appendDiagnostic(line: string): void {
    if (stepCapture?.diagnostics !== activeTurn?.diagnostics) {
      stepCapture?.diagnostics.push(line)
    }
    activeTurn?.diagnostics.push(line)
  }

  function ensureAuthenticatedAccount(account: unknown): void {
    const accountRecord = asRecord(account)
    if (accountRecord === undefined) {
      throw new Error("codex app-server returned an invalid account/read response")
    }
    if (Boolean(accountRecord["requiresOpenaiAuth"]) && accountRecord["account"] === null) {
      throw new Error("Codex CLI is not authenticated. Run `codex login` and retry.")
    }
  }

  async function withStepCapture<T>(operation: () => Promise<T>): Promise<T> {
    stepCapture = createStepCapture()
    try {
      return await operation()
    } finally {
      stepCapture = undefined
    }
  }

  function finalizeFailedTurn(turn: TurnResult): CodexStepResult {
    return {
      exitCode: 1,
      providerEvents: [...turn.providerEvents],
      result: null,
      stderr: turn.diagnostics.join("\n"),
      stdout: turn.errorMessage ?? turn.text,
    }
  }

  function failActiveTurn(error: Error): void {
    globalThis.process.off("SIGINT", sigintHandler)
    activeTurn?.reject(error)
    activeTurn = undefined
    stepCapture = undefined
  }

  appServer.child.once("exit", (code, signal) => {
    failActiveTurn(new Error(`codex app-server exited unexpectedly (code=${String(code)} signal=${String(signal)})`))
  })
  appServer.stderr.on("line", (line) => {
    if (isBenignCodexDiagnostic(line)) {
      return
    }
    appendDiagnostic(line)
    void emit({ kind: "diagnostic", message: line, provider: "codex" })
  })

  rpc.start({
    onError: async (error) => {
      failActiveTurn(error)
    },
    onNotification: async (message) => {
      await handleNotification(message.method, message.params)
    },
    onRequest: async (message) => {
      await handleRequest(message.id, message.method, message.params)
    },
  })

  const initializeParams: InitializeParams = {
    capabilities: null,
    clientInfo: {
      name: "@tryrigg/rigg",
      title: "Rigg",
      version: "0.0.0",
    },
  }
  await rpc.request("initialize", initializeParams)
  rpc.notify("initialized")

  ensureAuthenticatedAccount(await rpc.request("account/read", { refreshToken: false }))

  async function startThread(cwd: string, model: string | undefined): Promise<string> {
    const params: ThreadStartParams = {
      cwd,
      experimentalRawEvents: false,
      model: model ?? null,
      persistExtendedHistory: false,
    }
    const response = asRecord(await rpc.request("thread/start", params))
    const thread = asRecord(response?.["thread"])
    const threadId = readString(thread, "id")
    if (threadId === undefined) {
      throw new Error("thread/start response did not include a thread id")
    }
    return threadId
  }

  async function executeTurn(method: TurnMethod, params: ReviewStartParams | TurnStartParams): Promise<TurnResult> {
    if (activeTurn !== undefined) {
      throw new Error("codex runtime turn overlap is not supported")
    }

    const response = asRecord(await rpc.request(method, params))
    const turn = asRecord(response?.["turn"])
    const threadId =
      method === "review/start"
        ? (readString(response, "reviewThreadId") ?? readString(params, "threadId"))
        : readString(params, "threadId")
    const turnId = readString(turn, "id")
    if (threadId === undefined || turnId === undefined) {
      throw new Error(`${method} response did not include a turn id`)
    }

    return await new Promise<TurnResult>((resolve, reject) => {
      globalThis.process.on("SIGINT", sigintHandler)
      activeTurn = {
        assistantMessages: [],
        diagnostics: stepCapture?.diagnostics ?? [],
        errorMessage: null,
        interrupted: false,
        providerEvents: stepCapture?.providerEvents ?? [],
        reject,
        resolve,
        reviewText: null,
        threadId,
        turnId,
      }
    })
  }

  async function run(options_: {
    cwd: string
    model?: string | undefined
    outputSchema?: OutputDefinition | undefined
    prompt: string
  }): Promise<CodexStepResult> {
    return await withStepCapture(async () => {
      const threadId = await startThread(options_.cwd, options_.model)
      const prompt = buildRunPrompt(options_.prompt, options_.outputSchema)
      const params: TurnStartParams = {
        input: [{ text: prompt, text_elements: [], type: "text" }],
        model: options_.model ?? null,
        outputSchema: null,
        threadId,
      }
      const turn = await executeTurn("turn/start", params)
      if (turn.status !== "completed") {
        return finalizeFailedTurn(turn)
      }

      if (options_.outputSchema === undefined) {
        return {
          exitCode: 0,
          providerEvents: [...turn.providerEvents],
          result: turn.text,
          stderr: turn.diagnostics.join("\n"),
          stdout: turn.text,
        }
      }

      const parsed = parseJsonOutput(turn.text, "Codex")
      const validationErrors = validateOutputValue(options_.outputSchema, parsed)
      if (validationErrors.length > 0) {
        throw createStepFailedError(new Error(validationErrors.join("; ")))
      }

      return {
        exitCode: 0,
        providerEvents: [...turn.providerEvents],
        result: parsed,
        stderr: turn.diagnostics.join("\n"),
        stdout: typeof parsed === "string" ? parsed : stringifyJson(parsed),
      }
    })
  }

  async function review(options_: {
    cwd: string
    model?: string | undefined
    target: ThreadTarget
  }): Promise<CodexStepResult> {
    return await withStepCapture(async () => {
      const threadId = await startThread(options_.cwd, options_.model)
      const params: ReviewStartParams = {
        target: mapReviewTarget(options_.target),
        threadId,
      }
      const turn = await executeTurn("review/start", params)
      if (turn.status !== "completed") {
        return finalizeFailedTurn(turn)
      }

      const reviewResult = parseReviewText(turn.reviewText ?? turn.text)
      return {
        exitCode: 0,
        providerEvents: [...turn.providerEvents],
        result: reviewResult,
        stderr: turn.diagnostics.join("\n"),
        stdout: turn.reviewText ?? turn.text,
      }
    })
  }

  async function interruptActiveTurn(): Promise<void> {
    if (activeTurn === undefined) {
      return
    }
    const params: TurnInterruptParams = {
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
    }
    await rpc.request("turn/interrupt", params)
  }

  async function close(): Promise<void> {
    if (closed) {
      return
    }
    closed = true
    await rpc.close()
  }

  async function handleRequest(id: string | number, method: string, params: unknown): Promise<void> {
    const requestId = String(id)
    if (options.interactionHandler === undefined) {
      throw new Error(`codex app-server requested ${method}, but no interaction handler is configured`)
    }

    if (method === "item/commandExecution/requestApproval") {
      const request = parseApprovalRequest("command_execution", requestId, params)
      const resolution = await options.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      rpc.respond(id, { decision: resolution.decision })
      return
    }
    if (method === "item/fileChange/requestApproval") {
      const request = parseApprovalRequest("file_change", requestId, params)
      const resolution = await options.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      rpc.respond(id, { decision: resolution.decision === "accept" ? "accept" : resolution.decision })
      return
    }
    if (method === "item/permissions/requestApproval") {
      const request = parseApprovalRequest("permissions", requestId, params)
      const resolution = await options.interactionHandler(request)
      assertResolutionKind("approval", resolution)
      const permissions = readRecord(asRecord(params), "permissions")
      rpc.respond(id, {
        permissions: resolution.decision === "accept" ? (permissions ?? {}) : {},
        scope: resolution.scope ?? "turn",
      })
      return
    }
    if (method === "item/tool/requestUserInput") {
      const request = parseUserInputRequest(requestId, params)
      const resolution = await options.interactionHandler(request)
      assertResolutionKind("user_input", resolution)
      rpc.respond(id, { answers: resolution.answers })
      return
    }
    if (method === "mcpServer/elicitation/request") {
      const request = parseElicitationRequest(requestId, params)
      const resolution = await options.interactionHandler(request)
      assertResolutionKind("elicitation", resolution)
      rpc.respond(id, {
        _meta: resolution._meta ?? null,
        action: resolution.action,
        content: resolution.content ?? null,
      })
      return
    }

    throw new Error(`unsupported codex app-server server request: ${method}`)
  }

  async function handleNotification(method: string, params: unknown): Promise<void> {
    if (method === "error") {
      const message = readString(asRecord(params), "message") ?? "codex app-server reported an error"
      await emit({ kind: "error", message, provider: "codex" })
      if (activeTurn !== undefined) {
        activeTurn.errorMessage = message
      }
      return
    }

    if (method === "thread/started") {
      const id = readString(readRecord(asRecord(params), "thread"), "id")
      if (id !== undefined) {
        await emit({ kind: "status", message: `thread started ${id}`, provider: "codex" })
      }
      return
    }

    if (method === "turn/started") {
      const turn = readRecord(asRecord(params), "turn")
      const turnId = readString(turn, "id")
      if (turnId !== undefined) {
        await emit({ kind: "status", message: `turn started ${turnId}`, provider: "codex" })
      }
      return
    }

    if (method === "item/agentMessage/delta") {
      const delta = readString(asRecord(params), "delta")
      if (delta !== undefined && delta.trim().length > 0) {
        await emit({ kind: "status", message: delta, provider: "codex" })
      }
      return
    }

    if (method === "item/started") {
      const item = readRecord(asRecord(params), "item")
      if (item !== undefined) {
        const event = parseToolEvent(item)
        if (event !== undefined) {
          await emit(event)
        }
      }
      return
    }

    if (method === "item/completed") {
      const item = readRecord(asRecord(params), "item")
      if (item !== undefined) {
        const itemType = readString(item, "type")
        if (itemType === "agentMessage") {
          const text = readString(item, "text")
          if (text !== undefined) {
            activeTurn?.assistantMessages.push(text)
          }
          return
        }
        if (itemType === "codeReview") {
          const reviewText = readString(item, "review")
          if (reviewText !== undefined && activeTurn !== undefined) {
            activeTurn.reviewText = reviewText
          }
          return
        }
        if (itemType === "exitedReviewMode") {
          const reviewText = readString(item, "review")
          if (reviewText !== undefined && activeTurn !== undefined) {
            activeTurn.reviewText = reviewText
          }
          return
        }
      }
      return
    }

    if (method === "turn/completed") {
      const turn = readRecord(asRecord(params), "turn")
      const status = readString(turn, "status") ?? "failed"
      const errorMessage = readString(readRecord(turn, "error"), "message")
      if (activeTurn === undefined) {
        throw new Error("received turn/completed without an active turn")
      }

      const result: TurnResult = {
        diagnostics: activeTurn.diagnostics,
        errorMessage: errorMessage ?? activeTurn.errorMessage,
        interrupted: status === "interrupted",
        providerEvents: activeTurn.providerEvents,
        reviewText: activeTurn.reviewText,
        status,
        text: activeTurn.assistantMessages.join("\n"),
      }
      const resolve = activeTurn.resolve
      globalThis.process.off("SIGINT", sigintHandler)
      activeTurn = undefined
      resolve(result)
      return
    }

    if (SOFT_NOTIFICATION_METHODS.has(method)) {
      return
    }

    throw new Error(`unsupported codex app-server notification: ${method}`)
  }

  return {
    close,
    interruptActiveTurn,
    review,
    run,
  }
}

function assertResolutionKind<TKind extends CodexInteractionRequest["kind"]>(
  expected: TKind,
  resolution: CodexInteractionResolution,
): asserts resolution is Extract<CodexInteractionResolution, { kind: TKind }> {
  if (resolution.kind !== expected) {
    throw new Error(`interaction handler returned ${resolution.kind} for ${expected}`)
  }
}

function parseApprovalRequest(
  requestKind: "command_execution" | "file_change" | "permissions",
  requestId: string,
  params: unknown,
): Extract<CodexInteractionRequest, { kind: "approval" }> {
  const record = asRecord(params)
  if (record === undefined) {
    throw new Error(`codex app-server sent invalid ${requestKind} approval params`)
  }

  return {
    availableDecisions: readStringArray(record["availableDecisions"]) ?? [],
    command: readString(record, "command"),
    cwd: readString(record, "cwd"),
    itemId: readRequiredString(record, "itemId"),
    kind: "approval",
    message: readString(record, "reason") ?? `${requestKind.replaceAll("_", " ")} approval requested`,
    requestId,
    requestKind,
    turnId: readRequiredString(record, "turnId"),
  }
}

function parseUserInputRequest(
  requestId: string,
  params: unknown,
): Extract<CodexInteractionRequest, { kind: "user_input" }> {
  const record = asRecord(params)
  const questions = readArray(record, "questions")
  if (record === undefined || questions === undefined) {
    throw new Error("codex app-server sent invalid requestUserInput params")
  }

  return {
    itemId: readRequiredString(record, "itemId"),
    kind: "user_input",
    questions: questions.map((question) => {
      const questionRecord = asRecord(question)
      if (questionRecord === undefined) {
        throw new Error("codex app-server sent invalid requestUserInput question")
      }
      return {
        header: readRequiredString(questionRecord, "header"),
        id: readRequiredString(questionRecord, "id"),
        isOther: Boolean(questionRecord["isOther"]),
        isSecret: Boolean(questionRecord["isSecret"]),
        options:
          readArray(questionRecord, "options")?.map((option) => {
            const optionRecord = asRecord(option)
            if (optionRecord === undefined) {
              throw new Error("codex app-server sent invalid requestUserInput option")
            }
            return {
              description: readRequiredString(optionRecord, "description"),
              label: readRequiredString(optionRecord, "label"),
            }
          }) ?? null,
        question: readRequiredString(questionRecord, "question"),
      }
    }),
    requestId,
    turnId: readRequiredString(record, "turnId"),
  }
}

function parseElicitationRequest(
  requestId: string,
  params: unknown,
): Extract<CodexInteractionRequest, { kind: "elicitation" }> {
  const record = asRecord(params)
  if (record === undefined) {
    throw new Error("codex app-server sent invalid elicitation params")
  }

  const mode = readRequiredString(record, "mode")
  if (mode === "form") {
    return {
      itemId: null,
      kind: "elicitation",
      message: readRequiredString(record, "message"),
      mode,
      requestId,
      requestedSchema: readRecord(record, "requestedSchema") ?? {},
      serverName: readRequiredString(record, "serverName"),
      turnId: readNullableString(record, "turnId"),
    }
  }

  if (mode === "url") {
    return {
      elicitationId: readRequiredString(record, "elicitationId"),
      itemId: null,
      kind: "elicitation",
      message: readRequiredString(record, "message"),
      mode,
      requestId,
      serverName: readRequiredString(record, "serverName"),
      turnId: readNullableString(record, "turnId"),
      url: readRequiredString(record, "url"),
    }
  }

  throw new Error(`unsupported elicitation mode: ${mode}`)
}

function parseToolEvent(item: Record<string, unknown>): CodexProviderEvent | undefined {
  const type = readString(item, "type")
  if (type === "commandExecution") {
    return {
      detail: summarizePairs(item, ["command", "cwd"]),
      kind: "tool_use",
      provider: "codex",
      tool: "command_execution",
    }
  }
  if (type === "mcpToolCall") {
    return {
      detail: summarizePairs(item, ["server"]),
      kind: "tool_use",
      provider: "codex",
      tool: readString(item, "tool") ?? "mcp_tool_call",
    }
  }
  if (type === "fileChange") {
    return {
      kind: "tool_use",
      provider: "codex",
      tool: "file_change",
    }
  }
  if (type === "dynamicToolCall") {
    return {
      kind: "tool_use",
      provider: "codex",
      tool: readString(item, "tool") ?? "dynamic_tool_call",
    }
  }
  return undefined
}

function mapReviewTarget(target: ThreadTarget): ReviewStartTarget {
  if (target.type === "uncommitted") {
    return { type: "uncommittedChanges" }
  }
  if (target.type === "base") {
    return { branch: target.value, type: "baseBranch" }
  }
  return {
    sha: target.value,
    title: target.title ?? null,
    type: "commit",
  }
}

function buildRunPrompt(prompt: string, outputSchema: OutputDefinition | undefined): string {
  if (outputSchema === undefined) {
    return prompt
  }
  return [prompt, "", "Return only a JSON object that matches this schema exactly.", stringifyJson(outputSchema)].join(
    "\n",
  )
}

function parseJsonOutput(text: string, source: "Codex"): unknown {
  try {
    return parseJson(text.trim())
  } catch (error) {
    throw createStepFailedError(new Error(`${source} step returned invalid JSON: ${String(error)}`, { cause: error }))
  }
}

function parseReviewText(text: string): CodexReviewResult {
  const normalized = text.trim()
  const marker = normalized.indexOf("\nReview comment:")
  const pluralMarker = normalized.indexOf("\nFull review comments:")
  const headingIndex =
    marker >= 0
      ? marker + 1
      : pluralMarker >= 0
        ? pluralMarker + 1
        : normalized.startsWith("Review comment:") || normalized.startsWith("Full review comments:")
          ? 0
          : -1

  const explanation = (headingIndex >= 0 ? normalized.slice(0, headingIndex) : normalized).trim()
  const findingsBlock = headingIndex >= 0 ? normalized.slice(headingIndex) : ""

  return {
    findings: parseReviewFindings(findingsBlock),
    overall_confidence_score: 0,
    overall_correctness: "unknown",
    overall_explanation: explanation.length > 0 ? explanation : normalized,
  }
}

function parseReviewFindings(block: string): CodexReviewResult["findings"] {
  const findings: CodexReviewResult["findings"] = []
  let current:
    | {
        bodyLines: string[]
        location: string
        title: string
      }
    | undefined

  for (const line of block.split(/\r?\n/)) {
    const bullet = REVIEW_BULLET_PATTERN.exec(line)
    if (bullet?.[1] !== undefined && bullet[2] !== undefined) {
      if (current !== undefined) {
        findings.push(finalizeReviewFinding(current))
      }
      current = {
        bodyLines: [],
        location: bullet[2],
        title: bullet[1],
      }
      continue
    }

    if (current !== undefined && line.startsWith("  ")) {
      current.bodyLines.push(line.slice(2))
    }
  }

  if (current !== undefined) {
    findings.push(finalizeReviewFinding(current))
  }

  return findings
}

function finalizeReviewFinding(input: {
  bodyLines: string[]
  location: string
  title: string
}): CodexReviewResult["findings"][number] {
  const locationMatch = /^(.*):(\d+)-(\d+)$/.exec(input.location.trim())
  return {
    body: input.bodyLines.join("\n"),
    code_location: {
      absolute_file_path: locationMatch?.[1] ?? input.location,
      line_range: {
        end: Number.parseInt(locationMatch?.[3] ?? "0", 10),
        start: Number.parseInt(locationMatch?.[2] ?? "0", 10),
      },
    },
    confidence_score: 0,
    priority: null,
    title: input.title.trim(),
  }
}

function summarizePairs(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const details = keys
    .map((key) => {
      const candidate = value[key]
      return typeof candidate === "string" && candidate.length > 0 ? `${key}=${candidate}` : undefined
    })
    .filter((value): value is string => value !== undefined)
  return details.length === 0 ? undefined : details.join(" ")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readArray(record: Record<string, unknown> | undefined, key: string): unknown[] | undefined {
  const value = record?.[key]
  return Array.isArray(value) ? value : undefined
}

function readRecord(record: Record<string, unknown> | undefined, key?: string): Record<string, unknown> | undefined {
  if (key === undefined) {
    return record
  }
  return asRecord(record?.[key])
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

function readNullableString(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === "string" ? value : null
}

function readRequiredString(record: Record<string, unknown> | undefined, key: string): string {
  const value = readString(record, key)
  if (value === undefined) {
    throw new Error(`missing required codex field: ${key}`)
  }
  return value
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : undefined
}
