import { describe, expect, test } from "bun:test"

import {
  artifactsDir,
  compareParsedLogFileName,
  eventsPath,
  formatLogPath,
  isRunDirectoryName,
  logsDir,
  metaPath,
  parseLogFileName,
  runDir,
  runsDir,
  stagingRunDir,
  statePath,
  tempStatePath,
} from "../../src/history/fs"

describe("history/fs", () => {
  test("builds run history paths", () => {
    expect(runsDir("/workspace")).toBe("/workspace/.rigg/runs")
    expect(runDir("/workspace", "run-1")).toBe("/workspace/.rigg/runs/run-1")
    expect(stagingRunDir("/workspace", "run-1")).toBe("/workspace/.rigg/runs/.tmp-run-1")
    expect(logsDir("/workspace", "run-1")).toBe("/workspace/.rigg/runs/run-1/logs")
    expect(artifactsDir("/workspace", "run-1")).toBe("/workspace/.rigg/runs/run-1/artifacts")
    expect(statePath("/workspace", "run-1")).toBe("/workspace/.rigg/runs/run-1/state.json")
    expect(tempStatePath("/workspace", "run-1")).toBe("/workspace/.rigg/runs/run-1/state.json.tmp")
    expect(metaPath("/workspace", "run-1")).toBe("/workspace/.rigg/runs/run-1/meta.json")
    expect(eventsPath("/workspace", "run-1")).toBe("/workspace/.rigg/runs/run-1/events.jsonl")
  })

  test("recognizes run directory names", () => {
    expect(isRunDirectoryName("019cc300-0000-7000-8000-000000000001")).toBe(true)
    expect(isRunDirectoryName(".tmp-019cc300-0000-7000-8000-000000000001")).toBe(false)
    expect(isRunDirectoryName("not-a-run")).toBe(false)
  })

  test("round-trips formatted log file names", () => {
    const relativePath = formatLogPath("root.loop.scope", "/10/2", 3, "stdout")
    const fileName = relativePath.split("/").at(-1)

    expect(relativePath).toBe("logs/frame=root.loop.scope.path=s00000002_10s00000001_2.attempt-3.stdout.log")
    expect(fileName).toBeDefined()
    if (fileName === undefined) {
      throw new Error("expected log file name")
    }
    expect(parseLogFileName(fileName)).toEqual({
      attempt: 3,
      fileName,
      frameId: "root.loop.scope",
      nodePath: "/10/2",
      stream: "stdout",
    })
  })

  test("rejects invalid log file names", () => {
    expect(parseLogFileName("frame=root.path=broken.attempt-x.stdout.log")).toBeUndefined()
    expect(parseLogFileName("bad.log")).toBeUndefined()
  })

  test("sorts parsed log file names by node path, frame, and attempt", () => {
    const parsed = [
      parseLogFileName("frame=root.path=s00000002_10.attempt-1.stdout.log"),
      parseLogFileName("frame=root.parallel.path=s00000001_2.attempt-2.stdout.log"),
      parseLogFileName("frame=root.path=s00000001_2.attempt-1.stdout.log"),
    ].filter((value) => value !== undefined)

    expect(parsed.sort(compareParsedLogFileName).map((value) => value.fileName)).toEqual([
      "frame=root.path=s00000001_2.attempt-1.stdout.log",
      "frame=root.parallel.path=s00000001_2.attempt-2.stdout.log",
      "frame=root.path=s00000002_10.attempt-1.stdout.log",
    ])
  })
})
