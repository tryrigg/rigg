import { join } from "node:path"

import {
  compareFrameId,
  compareNodePath,
  nodePathFileComponent,
  nodePathFromFileComponent,
  type FrameId,
  type NodePath,
} from "../compile/schema"

export type LogStream = "stderr" | "stdout"

export type ParsedLogFileName = {
  attempt: number
  fileName: string
  frameId: FrameId
  nodePath: NodePath
  stream: LogStream
}

const RUN_ID_DIRECTORY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function runsDir(projectRoot: string): string {
  return join(projectRoot, ".rigg", "runs")
}

export function runDir(projectRoot: string, runId: string): string {
  return join(runsDir(projectRoot), runId)
}

export function stagingRunDir(projectRoot: string, runId: string): string {
  return join(runsDir(projectRoot), `.tmp-${runId}`)
}

export function logsDir(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "logs")
}

export function artifactsDir(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "artifacts")
}

export function statePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "state.json")
}

export function tempStatePath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "state.json.tmp")
}

export function metaPath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "meta.json")
}

export function eventsPath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "events.jsonl")
}

export function isRunDirectoryName(value: string): boolean {
  return RUN_ID_DIRECTORY_PATTERN.test(value)
}

export function formatLogPath(frameId: FrameId, nodePath: NodePath, attempt: number, stream: LogStream): string {
  return `logs/frame=${frameId}.path=${nodePathFileComponent(nodePath)}.attempt-${attempt}.${stream}.log`
}

export function parseLogFileName(fileName: string): ParsedLogFileName | undefined {
  const framePrefix = "frame="
  const pathMarker = ".path="
  const attemptMarker = ".attempt-"

  if (!fileName.startsWith(framePrefix)) {
    return undefined
  }

  const pathIndex = fileName.indexOf(pathMarker)
  const attemptIndex = fileName.indexOf(attemptMarker)
  if (pathIndex < 0 || attemptIndex < 0 || pathIndex <= framePrefix.length) {
    return undefined
  }

  const frameId = fileName.slice(framePrefix.length, pathIndex)
  const nodeComponent = fileName.slice(pathIndex + pathMarker.length, attemptIndex)
  const rest = fileName.slice(attemptIndex + attemptMarker.length)
  const streamMatch = rest.match(/^(\d+)\.(stdout|stderr)\.log$/)
  if (streamMatch === null) {
    return undefined
  }

  const attemptText = streamMatch[1]
  const streamText = streamMatch[2]
  if (attemptText === undefined || streamText === undefined) {
    return undefined
  }

  const nodePath = nodePathFromFileComponent(nodeComponent)
  if (nodePath === undefined) {
    return undefined
  }
  if (streamText !== "stdout" && streamText !== "stderr") {
    return undefined
  }

  return {
    attempt: Number.parseInt(attemptText, 10),
    fileName,
    frameId,
    nodePath,
    stream: streamText,
  }
}

export function compareParsedLogFileName(left: ParsedLogFileName, right: ParsedLogFileName): number {
  return (
    compareNodePath(left.nodePath, right.nodePath) ||
    compareFrameId(left.frameId, right.frameId) ||
    left.attempt - right.attempt ||
    left.fileName.localeCompare(right.fileName)
  )
}
