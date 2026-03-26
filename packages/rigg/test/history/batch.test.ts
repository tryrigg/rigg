import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { RunEvent } from "../../src/session/event"
import { createBatch, createState, pushEvent } from "../../src/history/batch"
import { OUTPUT_PREVIEW_MAX_BYTES } from "../../src/history/output"
import { nodeSnapshot } from "../fixture/history"
import { runSnapshot } from "../fixture/builders"

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop()
    if (path !== undefined) {
      rmSync(path, { force: true, recursive: true })
    }
  }
})

function makeState() {
  const path = mkdtempSync(join(tmpdir(), "rigg-batch-"))
  tempDirs.push(path)
  return createState(path)
}

function apply(batch: ReturnType<typeof createBatch>, state: ReturnType<typeof createState>, event: RunEvent) {
  return pushEvent(state, batch, {
    event,
    projectId: "project-1",
    workspaceId: "workspace-1",
    recordingStatus: "complete",
    runId: "run-1",
  })
}

function payloadText(value: { payload: { text?: string | null } | null | undefined }) {
  return value.payload?.text ?? null
}

function payloadData(value: { payload: { data?: unknown } | null | undefined }) {
  return value.payload?.data ?? null
}

function stdoutPreview(value: { payload: { stdout?: { preview?: string | null } | null } | null | undefined }) {
  return value.payload?.stdout?.preview ?? null
}

function stdoutPath(value: { payload: { stdout?: { path?: string | null } | null } | null | undefined }) {
  return value.payload?.stdout?.path ?? null
}

function stderrPreview(value: { payload: { stderr?: { preview?: string | null } | null } | null | undefined }) {
  return value.payload?.stderr?.preview ?? null
}

function resultJson(value: { payload: { result?: unknown } | null | undefined }) {
  const result = value.payload?.result
  if (result === null || result === undefined) {
    return null
  }
  if (typeof result === "string") {
    return result
  }
  return JSON.stringify(result)
}

function getOnlyStep(batch: ReturnType<typeof createBatch>) {
  const steps = [...batch.steps.values()]
  expect(steps).toHaveLength(1)
  return steps[0]
}

describe("history/batch", () => {
  test("replaces partial stream output with the final node snapshot", () => {
    const batch = createBatch()
    const state = makeState()

    apply(batch, state, {
      chunk: "prefix\n",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "node_completed",
      node: nodeSnapshot({
        duration_ms: 3900,
        finished_at: "2026-03-24T05:32:05.000Z",
        status: "succeeded",
        stderr: "warn\n",
        stdout: "prefix\nsuffix\n",
      }),
      snapshot: runSnapshot({ run_id: "run-1", workflow_id: "plan" }),
    })

    const step = getOnlyStep(batch)
    expect(stdoutPreview(step!)).toBe("prefix\nsuffix\n")
    expect(stderrPreview(step!)).toBe("warn\n")
  })

  test("preserves empty step fields instead of coercing them to null", () => {
    const batch = createBatch()
    const state = makeState()

    apply(batch, state, {
      kind: "node_completed",
      node: nodeSnapshot({
        duration_ms: 1000,
        finished_at: "2026-03-24T05:32:02.000Z",
        result: "",
        status: "succeeded",
        stderr: "",
        stdout: "",
      }),
      snapshot: runSnapshot({ run_id: "run-1", workflow_id: "plan" }),
    })

    const step = getOnlyStep(batch)
    expect(stdoutPreview(step!)).toBe("")
    expect(stderrPreview(step!)).toBe("")
    expect(resultJson(step!)).toBe("")
  })

  test("stores full output in a file when preview bytes overflow", () => {
    const batch = createBatch()
    const state = makeState()
    const chunk = `${"a".repeat(OUTPUT_PREVIEW_MAX_BYTES - 1)}あ`

    const truncated = apply(batch, state, {
      chunk,
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "code-review",
    })
    expect(truncated).toBe(false)

    apply(batch, state, {
      kind: "node_completed",
      node: nodeSnapshot({
        duration_ms: 1000,
        finished_at: "2026-03-24T05:32:02.000Z",
        status: "succeeded",
      }),
      snapshot: runSnapshot({ run_id: "run-1", workflow_id: "plan" }),
    })

    const step = getOnlyStep(batch)
    expect(stdoutPreview(step!)).toBe("a".repeat(OUTPUT_PREVIEW_MAX_BYTES - 1))
    expect(Buffer.byteLength(stdoutPreview(step!) ?? "", "utf8")).toBe(OUTPUT_PREVIEW_MAX_BYTES - 1)
    expect(stdoutPreview(step!)?.includes("\uFFFD")).toBe(false)
    expect(stdoutPath(step!)).toBeTruthy()
    expect(readFileSync(stdoutPath(step!)!, "utf8")).toBe(chunk)
  })

  test("keeps completed assistant text from duplicating deltas", () => {
    const batch = createBatch()
    const state = makeState()

    apply(batch, state, {
      kind: "provider_event",
      event: {
        itemId: "msg_1",
        kind: "message_delta",
        provider: "codex",
        text: "Hel",
        threadId: "thread_1",
        turnId: "turn_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "provider_event",
      event: {
        itemId: "msg_1",
        kind: "message_delta",
        provider: "codex",
        text: "lo",
        threadId: "thread_1",
        turnId: "turn_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "provider_event",
      event: {
        itemId: "msg_1",
        kind: "message_completed",
        provider: "codex",
        text: "Hello",
        threadId: "thread_1",
        turnId: "turn_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })

    expect(batch.events).toHaveLength(1)
    expect(payloadText(batch.events[0]!)).toBe("Hello")
    expect(payloadData(batch.events[0]!)).toMatchObject({ kind: "message_completed" })
  })

  test("merges assistant completion across interleaved provider events", () => {
    const batch = createBatch()
    const state = makeState()

    apply(batch, state, {
      kind: "provider_event",
      event: {
        itemId: "msg_1",
        kind: "message_delta",
        provider: "codex",
        text: "Hel",
        threadId: "thread_1",
        turnId: "turn_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "provider_event",
      event: {
        detail: "search",
        itemId: "msg_1",
        kind: "tool_started",
        provider: "codex",
        threadId: "thread_1",
        tool: "grep",
        turnId: "turn_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "provider_event",
      event: {
        itemId: "msg_1",
        kind: "message_completed",
        provider: "codex",
        text: "Hello",
        threadId: "thread_1",
        turnId: "turn_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })

    expect(batch.events.map((entry) => entry.kind)).toEqual(["assistant", "event"])
    expect(payloadText(batch.events[0]!)).toBe("Hello")
    expect(payloadData(batch.events[0]!)).toMatchObject({ kind: "message_completed" })
    expect(payloadText(batch.events[1]!)).toContain("tool started: grep")
  })

  test("keeps anonymous Codex assistant messages distinct within one turn", () => {
    const batch = createBatch()
    const state = makeState()

    apply(batch, state, {
      kind: "provider_event",
      event: {
        itemId: null,
        kind: "message_completed",
        provider: "codex",
        text: "First",
        threadId: "thread_1",
        turnId: "turn_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "provider_event",
      event: {
        itemId: null,
        kind: "message_completed",
        provider: "codex",
        text: "Second",
        threadId: "thread_1",
        turnId: "turn_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })

    expect(batch.events.map((entry) => payloadText(entry))).toEqual(["First", "Second"])
  })

  test("flushes Cursor assistant deltas without waiting for completion", () => {
    const batch = createBatch()
    const state = makeState()

    apply(batch, state, {
      kind: "provider_event",
      event: {
        kind: "message_delta",
        messageId: "msg_1",
        provider: "cursor",
        sessionId: "session_1",
        text: "Hel",
      },
      node_path: "/0",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "provider_event",
      event: {
        kind: "message_delta",
        messageId: "msg_1",
        provider: "cursor",
        sessionId: "session_1",
        text: "lo",
      },
      node_path: "/0",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "provider_event",
      event: {
        kind: "diagnostic",
        message: "still running",
        provider: "cursor",
        sessionId: "session_1",
      },
      node_path: "/0",
      user_id: "code-review",
    })

    expect(batch.events.map((entry) => entry.kind)).toEqual(["assistant", "event"])
    expect(payloadText(batch.events[0]!)).toBe("Hello")
    expect(payloadData(batch.events[0]!)).toMatchObject({ kind: "message_delta", provider: "cursor" })
    expect(payloadText(batch.events[1]!)).toBe("diagnostic: still running")
  })

  test("keeps separate rows for repeated attempts on the same node path", () => {
    const batch = createBatch()
    const state = makeState()

    apply(batch, state, {
      kind: "node_started",
      node: nodeSnapshot({ attempt: 1, status: "running" }),
      snapshot: runSnapshot({ run_id: "run-1", workflow_id: "plan" }),
    })
    apply(batch, state, {
      chunk: "first attempt\n",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "node_completed",
      node: nodeSnapshot({
        attempt: 1,
        finished_at: "2026-03-24T05:32:02.000Z",
        status: "failed",
        stdout: "first attempt\n",
      }),
      snapshot: runSnapshot({ run_id: "run-1", workflow_id: "plan" }),
    })
    apply(batch, state, {
      kind: "node_started",
      node: nodeSnapshot({ attempt: 2, status: "running" }),
      snapshot: runSnapshot({ run_id: "run-1", workflow_id: "plan" }),
    })
    apply(batch, state, {
      chunk: "second attempt\n",
      kind: "step_output",
      node_path: "/0",
      stream: "stdout",
      user_id: "code-review",
    })
    apply(batch, state, {
      kind: "node_completed",
      node: nodeSnapshot({
        attempt: 2,
        finished_at: "2026-03-24T05:32:03.000Z",
        status: "succeeded",
        stdout: "second attempt\n",
      }),
      snapshot: runSnapshot({ run_id: "run-1", workflow_id: "plan" }),
    })

    const steps = [...batch.steps.values()].sort((left, right) => left.attempt - right.attempt)
    expect(steps.map((step) => step.attempt)).toEqual([1, 2])
    expect(steps.map((step) => stdoutPreview(step))).toEqual(["first attempt\n", "second attempt\n"])
    expect(batch.events.filter((entry) => entry.kind === "stream").map((entry) => entry.attempt)).toEqual([1, 2])
  })
})
