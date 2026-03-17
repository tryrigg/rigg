import { describe, expect, test } from "bun:test"

import type { ActiveLiveOutput, CompletedOutput } from "../../../src/cli/run"
import { completedOutputToLines, countRenderableLiveOutputs } from "../../../src/cli/tui/workflow-tree"

describe("completedOutputToLines", () => {
  test("preserves preview lines when completed output already has streamed entries", () => {
    const completed: CompletedOutput = {
      entries: [
        {
          key: null,
          stream: "stdout",
          text: "working\nstill working",
          variant: "stream",
        },
      ],
      preview: {
        stream: "stderr",
        text: "permission denied",
      },
    }

    expect(completedOutputToLines(completed)).toEqual([
      { isStderr: false, muted: false, text: "still working" },
      { isStderr: true, muted: false, text: "stderr: permission denied" },
    ])
  })

  test("omits duplicate preview lines when they already match the streamed tail", () => {
    const completed: CompletedOutput = {
      entries: [
        {
          key: null,
          stream: "stderr",
          text: "permission denied",
          variant: "stream",
        },
      ],
      preview: {
        stream: "stderr",
        text: "permission denied",
      },
    }

    expect(completedOutputToLines(completed)).toEqual([
      { isStderr: true, muted: false, text: "stderr: permission denied" },
    ])
  })

  test("preserves stderr preview lines even when stdout contains the same text", () => {
    const completed: CompletedOutput = {
      entries: [
        {
          key: null,
          stream: "stdout",
          text: "permission denied\nline 2\nline 3",
          variant: "stream",
        },
      ],
      preview: {
        stream: "stderr",
        text: "... +1 earlier lines\npermission denied",
      },
    }

    expect(completedOutputToLines(completed)).toEqual([
      { isStderr: true, muted: false, text: "stderr: ... +1 earlier lines" },
      { isStderr: true, muted: false, text: "permission denied" },
    ])
  })

  test("keeps the latest streamed tail when preview contains an older snapshot", () => {
    const completed: CompletedOutput = {
      entries: [
        {
          key: null,
          stream: "stdout",
          text: "line 1\nline 2\nline 3",
          variant: "stream",
        },
      ],
      preview: {
        stream: "stdout",
        text: "line 1\nline 2",
      },
    }

    expect(completedOutputToLines(completed)).toEqual([
      { isStderr: false, muted: false, text: "line 2" },
      { isStderr: false, muted: false, text: "line 3" },
    ])
  })

  test("keeps preview truncation context when only final output is available", () => {
    const completed: CompletedOutput = {
      entries: [],
      preview: {
        stream: "stderr",
        text: "... +1 earlier lines\nline 2\nline 3\nline 4",
      },
    }

    expect(completedOutputToLines(completed)).toEqual([
      { isStderr: true, muted: false, text: "stderr: ... +1 earlier lines" },
      { isStderr: true, muted: false, text: "line 2" },
      { isStderr: true, muted: false, text: "line 3" },
      { isStderr: true, muted: false, text: "line 4" },
    ])
  })
})

describe("countRenderableLiveOutputs", () => {
  test("counts only live outputs with visible lines", () => {
    const liveOutputs: Record<string, ActiveLiveOutput> = {
      "/group": { entries: [] },
      "/shell": {
        entries: [
          {
            key: null,
            stream: "stdout",
            text: "hello",
            variant: "stream",
          },
        ],
      },
      "/empty-stream": {
        entries: [
          {
            key: null,
            stream: "stdout",
            text: "",
            variant: "stream",
          },
        ],
      },
    }

    expect(countRenderableLiveOutputs(liveOutputs)).toBe(1)
  })
})
