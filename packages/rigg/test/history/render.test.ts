import { describe, expect, test } from "bun:test"

import {
  formatRelativeTime,
  renderAmbiguousStep,
  renderEmptyHistoryPage,
  renderHistory,
  renderLogView,
  renderNoFilteredRuns,
  renderNoRunOutput,
  renderNoStepOutput,
  renderNoRuns,
  renderMissingStep,
  renderRunView,
  renderWorkflowList,
} from "../../src/history/render"

function withCols<T>(cols: number, run: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "columns")
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: cols })
  try {
    return run()
  } finally {
    if (desc) {
      Object.defineProperty(process.stdout, "columns", desc)
    } else {
      delete (process.stdout as { columns?: number }).columns
    }
  }
}

const item = {
  durationMs: 42100,
  finishedAt: "2026-03-24T05:32:43.100Z",
  reason: "step_failed" as const,
  recordingStatus: "complete" as const,
  runId: "d3f8a1c4-9e2b-4f7a-8d1c-3e5f7a9b2c4d",
  shortId: "d3f8a1c49e2b4",
  startedAt: "2026-03-24T05:32:01.000Z",
  status: "failed" as const,
  workflowId: "plan",
}

describe("history/render", () => {
  test("renders empty history guidance", () => {
    expect(renderNoRuns()).toEqual([
      "No runs recorded yet. Run a workflow to start tracking history:",
      "",
      "  rigg run <workflow_id>",
    ])
    expect(renderEmptyHistoryPage(100)).toEqual(["No runs found at offset 100."])
    expect(renderEmptyHistoryPage(100, { workflowId: "plan" })).toEqual([
      'No runs found for workflow "plan" at offset 100.',
    ])
    expect(renderNoFilteredRuns({ status: "failed" })).toEqual(['No runs found with status "failed".'])
  })

  test("renders history and run details", () => {
    const history = renderHistory([item], new Date("2026-03-24T05:34:01.000Z"), false).join("\n")
    expect(history).toContain("STATUS")
    expect(history).toContain("failed")
    expect(history).toContain("2 minutes ago")

    const runView = renderRunView(
      {
        ...item,
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "failed",
            stderrPath: null,
            stderrPreview: "Error: blocked",
            stdoutPath: null,
            stdoutPreview: "Reviewing plan...",
            userId: "code-review",
          },
        ],
      },
      false,
    ).join("\n")
    expect(runView).toContain("▸ rigg · plan · d3f8a1c49e2b4")
    expect(runView).toContain("run d3f8a1c49e2b4")
  })

  test("includes interrupted and skipped nodes in the run summary footer", () => {
    const runView = renderRunView(
      {
        ...item,
        reason: "aborted",
        status: "aborted",
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "interrupted",
            stderrPath: null,
            stderrPreview: "interrupted",
            stdoutPath: null,
            stdoutPreview: null,
            userId: "build",
          },
          {
            attempt: 1,
            durationMs: null,
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/1",
            resultJson: null,
            startedAt: null,
            status: "skipped",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: null,
            userId: "deploy",
          },
        ],
      },
      false,
    ).join("\n")

    expect(runView).toContain("1 interrupted")
    expect(runView).toContain("1 skipped")
    expect(runView).not.toContain("0 succeeded")
  })

  test("includes running and pending nodes in the run summary footer", () => {
    const runView = renderRunView(
      {
        ...item,
        durationMs: 9000,
        finishedAt: null,
        reason: null,
        recordingStatus: "partial",
        status: "running",
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            exitCode: null,
            finishedAt: null,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "running",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: "Still working...",
            userId: "build",
          },
          {
            attempt: 1,
            durationMs: null,
            exitCode: null,
            finishedAt: null,
            nodeKind: "shell",
            nodePath: "/1",
            resultJson: null,
            startedAt: null,
            status: "pending",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: null,
            userId: "deploy",
          },
        ],
      },
      false,
    ).join("\n")

    expect(runView).toContain("1 running")
    expect(runView).toContain("1 pending")
    expect(runView).not.toContain("0 succeeded")
  })

  test("renders step selector errors and partial no-output messages", () => {
    expect(
      renderMissingStep("deploy", "d3f8a1c49e2b4", [
        { nodePath: "/0", userId: "build" },
        { nodePath: "/1", userId: null },
      ]),
    ).toEqual(['Step "deploy" not found in run d3f8a1c49e2b4.', "", "Steps in this run:", "  build (/0), /1"])

    expect(
      renderAmbiguousStep("build", "d3f8a1c49e2b4", [
        { nodePath: "/0", userId: "build" },
        { nodePath: "/1", userId: "build" },
      ]),
    ).toEqual([
      'Step selector "build" matches 2 steps in run d3f8a1c49e2b4.',
      "",
      "Use a node path to disambiguate:",
      "  build (/0)",
      "  build (/1)",
    ])

    expect(renderNoRunOutput("d3f8a1c49e2b4", "partial")).toEqual([
      "Run d3f8a1c49e2b4 was only partially recorded, and no output is available.",
    ])
    expect(renderNoStepOutput("build", "d3f8a1c49e2b4", "partial")).toEqual([
      'Run d3f8a1c49e2b4 was only partially recorded, and no output is available for step "build".',
    ])
  })

  test("renders logs and workflow list", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [{ data: null, kind: "stream", seq: 1, stream: "stdout", text: "Reviewing plan..." }],
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "failed",
            stderrPath: null,
            stderrPreview: "Error: blocked",
            stdoutPath: null,
            stdoutPreview: "Reviewing plan...",
            userId: "code-review",
          },
        ],
      },
      false,
    ).join("\n")
    expect(logs).toContain("▸ code-review (shell)")
    expect(logs).toContain("│ Reviewing plan...")

    const list = renderWorkflowList(
      [{ lastRun: item, stepCount: 3, workflowId: "plan" }],
      new Date("2026-03-24T05:34:01.000Z"),
      false,
    ).join("\n")
    expect(list).toContain("WORKFLOW")
    expect(list).toContain("plan")
    expect(list).toContain("3")
  })

  test("renders sub-minute relative time as just now", () => {
    expect(formatRelativeTime(item.finishedAt, new Date("2026-03-24T05:32:50.000Z"))).toBe("just now")
  })

  test("uses finished time for workflow last-run recency when available", () => {
    const list = renderWorkflowList(
      [{ lastRun: item, stepCount: 3, workflowId: "plan" }],
      new Date("2026-03-24T06:31:01.000Z"),
      false,
    ).join("\n")

    expect(list).toContain("58 minutes ago")
    expect(list).not.toContain("59 minutes ago")
  })

  test("includes missing final output after streamed entries", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [{ data: null, kind: "stream", seq: 1, stream: "stdout", text: "prefix\n" }],
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "failed",
            stderrPath: null,
            stderrPreview: "ERR\n",
            stdoutPath: null,
            stdoutPreview: "prefix\nsuffix\n",
            userId: "code-review",
          },
        ],
      },
      false,
    ).join("\n")

    expect(logs).toContain("│ prefix")
    expect(logs).toContain("│ suffix")
    expect(logs).toContain("│ ERR")
  })

  test("shows the saved file path when preview output is truncated", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [],
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "failed",
            stderrPath: "/tmp/rigg/run-1/%2F0#1.stderr.log",
            stderrPreview: null,
            stdoutPath: "/tmp/rigg/run-1/%2F0#1.stdout.log",
            stdoutPreview: "preview\n",
            userId: "code-review",
          },
        ],
      },
      false,
    ).join("\n")

    expect(logs).toContain("│ preview")
    expect(logs).toContain("stdout truncated; full output saved to /tmp/rigg/run-1/%2F0#1.stdout.log")
    expect(logs).toContain("stderr truncated; full output saved to /tmp/rigg/run-1/%2F0#1.stderr.log")
  })

  test("does not render an empty boxed row for trailing newlines", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [{ data: null, kind: "stream", seq: 1, stream: "stdout", text: "echo hi\n" }],
            exitCode: 0,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "succeeded",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: "echo hi\n",
            userId: "code-review",
          },
        ],
      },
      false,
    )

    expect(logs.filter((line) => line === "│ ")).toHaveLength(0)
    expect(logs.filter((line) => line === "│ echo hi")).toHaveLength(1)
  })

  test("renders run-level log entries before step output", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [{ data: null, kind: "event", seq: 1, stream: null, text: "barrier resolved: continue" }],
        steps: [],
      },
      false,
    ).join("\n")

    expect(logs).toContain("▸ run")
    expect(logs).toContain("│ barrier resolved: continue")
  })

  test("does not print assistant replies twice when stdout matches provider events", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [{ data: { kind: "message_completed" }, kind: "assistant", seq: 1, stream: null, text: "Hello" }],
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "codex",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "succeeded",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: "Hello",
            userId: "code-review",
          },
        ],
      },
      false,
    ).join("\n")

    expect(logs.match(/│ Hello/g)).toHaveLength(1)
  })

  test("does not print assistant replies twice when stdout only differs by trailing newline", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [
              { data: { kind: "message_completed" }, kind: "assistant", seq: 1, stream: null, text: "Hello\n" },
            ],
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "codex",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "succeeded",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: "Hello",
            userId: "code-review",
          },
        ],
      },
      false,
    ).join("\n")

    expect(logs.match(/│ Hello/g)).toHaveLength(1)
  })

  test("preserves trailing spaces from final stdout when streamed output differs only by whitespace", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [{ data: null, kind: "stream", seq: 1, stream: "stdout", text: "Hello" }],
            exitCode: 0,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "succeeded",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: "Hello  ",
            userId: "code-review",
          },
        ],
      },
      false,
    )

    expect(logs.filter((line) => line === "│ Hello")).toHaveLength(0)
    expect(logs.filter((line) => line === "│   ")).toHaveLength(0)
    expect(logs.filter((line) => line === "│ Hello  ")).toHaveLength(1)
  })

  test("does not treat stdout as a suffix when it only matches after ignoring newlines in the stream", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [{ data: null, kind: "stream", seq: 1, stream: "stdout", text: "Hello\n" }],
            exitCode: 0,
            finishedAt: item.finishedAt,
            nodeKind: "shell",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "succeeded",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: "HelloWorld",
            userId: "code-review",
          },
        ],
      },
      false,
    ).join("\n")

    expect(logs).toContain("│ HelloWorld")
    expect(logs.match(/│ World/g)).toBeNull()
  })

  test("does not duplicate stdout when stream and assistant precede the same final output", () => {
    const logs = renderLogView(
      {
        ...item,
        runEntries: [],
        steps: [
          {
            attempt: 1,
            durationMs: 3900,
            entries: [
              { data: null, kind: "stream", seq: 1, stream: "stdout", text: "prefix\n" },
              { data: { kind: "message_completed" }, kind: "assistant", seq: 2, stream: null, text: "Hello" },
            ],
            exitCode: null,
            finishedAt: item.finishedAt,
            nodeKind: "codex",
            nodePath: "/0",
            resultJson: null,
            startedAt: item.startedAt,
            status: "succeeded",
            stderrPath: null,
            stderrPreview: null,
            stdoutPath: null,
            stdoutPreview: "prefix\nHello",
            userId: "code-review",
          },
        ],
      },
      false,
    ).join("\n")

    expect(logs.match(/│ prefix/g)).toHaveLength(1)
    expect(logs.match(/│ Hello/g)).toHaveLength(1)
  })

  test("does not truncate colored status cells by ANSI width", () => {
    const list = renderWorkflowList(
      [{ lastRun: { ...item, status: "succeeded" }, stepCount: 3, workflowId: "plan" }],
      new Date("2026-03-24T05:34:01.000Z"),
      true,
    ).join("\n")

    expect(list).toContain("succeeded")
    expect(list).not.toContain("succeed…")
  })

  test("keeps workflow tables within the terminal width when workflow ids are long", () => {
    const list = withCols(80, () =>
      renderWorkflowList(
        [
          {
            lastRun: { ...item, status: "succeeded" },
            stepCount: 3,
            workflowId: "workflow-".repeat(10),
          },
        ],
        new Date("2026-03-24T05:34:01.000Z"),
        false,
      ),
    )

    expect(list.every((line) => line.length <= 80)).toBe(true)
    expect(list.join("\n")).toContain("workflow-")
    expect(list.join("\n")).toContain("…")
  })
})
