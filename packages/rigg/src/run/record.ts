import { appendFile, mkdir, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { FrameId, NodePath } from "../compile/schema"
import {
  eventsPath,
  formatLogPath,
  artifactsDir,
  logsDir,
  runDir,
  stagingRunDir,
  statePath,
  tempStatePath,
  type LogStream,
} from "../history/fs"
import type { RunSnapshot } from "../history/schema"
import { normalizeError } from "../util/error"
import { stringifyJson, stringifyJsonCompact } from "../util/json"
import { createInitialRunState } from "./state"

export type RunRecorder = {
  projectRoot: string
  runId: string
}

export async function createRunRecorder(
  projectRoot: string,
  runId: string,
  meta: {
    configFiles: string[]
    configHash: string
    cwd: string
    invocationInputs: Record<string, unknown>
    startedAt: string
    toolVersion: string
    workflowId: string
  },
): Promise<RunRecorder> {
  try {
    const stagingDirectory = stagingRunDir(projectRoot, runId)
    const directory = runDir(projectRoot, runId)
    await mkdir(join(stagingDirectory, "logs"), { recursive: true })
    await mkdir(join(stagingDirectory, "artifacts"), { recursive: true })
    const json = stringifyJson({
      config_files: meta.configFiles,
      config_hash: meta.configHash,
      cwd: meta.cwd,
      invocation_inputs: meta.invocationInputs,
      run_id: runId,
      started_at: meta.startedAt,
      tool_version: meta.toolVersion,
      workflow_id: meta.workflowId,
    })
    await Bun.write(
      join(stagingDirectory, "state.json"),
      stringifyJson(createInitialRunState(runId, meta.workflowId, meta.startedAt)),
    )
    await Bun.write(join(stagingDirectory, "meta.json"), json)
    await rename(stagingDirectory, directory)
    return { projectRoot, runId }
  } catch (error) {
    throw normalizeError(error)
  }
}

export async function persistRunSnapshot(recorder: RunRecorder, snapshot: RunSnapshot): Promise<void> {
  try {
    const tempPath = tempStatePath(recorder.projectRoot, recorder.runId)
    await Bun.write(tempPath, stringifyJson(snapshot))
    await rename(tempPath, statePath(recorder.projectRoot, recorder.runId))
  } catch (error) {
    throw normalizeError(error)
  }
}

export async function appendEvent(recorder: RunRecorder, event: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(eventsPath(recorder.projectRoot, recorder.runId), `${stringifyJsonCompact(event)}\n`, "utf8")
  } catch (error) {
    throw normalizeError(error)
  }
}

export async function writeNodeLog(
  recorder: RunRecorder,
  frameId: FrameId,
  nodePath: NodePath,
  attempt: number,
  stream: LogStream,
  content: string,
): Promise<string | undefined> {
  if (content.length === 0) {
    return undefined
  }

  try {
    const relativePath = formatLogPath(frameId, nodePath, attempt, stream)
    const absolutePath = join(runDir(recorder.projectRoot, recorder.runId), relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await Bun.write(absolutePath, content)
    return relativePath
  } catch (error) {
    throw normalizeError(error)
  }
}

export async function appendNodeLog(
  recorder: RunRecorder,
  frameId: FrameId,
  nodePath: NodePath,
  attempt: number,
  stream: LogStream,
  chunk: string,
): Promise<string> {
  const relativePath = formatLogPath(frameId, nodePath, attempt, stream)
  const absolutePath = join(runDir(recorder.projectRoot, recorder.runId), relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await appendFile(absolutePath, chunk, "utf8")
  return relativePath
}

export function recorderLogsDir(recorder: RunRecorder): string {
  return logsDir(recorder.projectRoot, recorder.runId)
}

export function recorderArtifactsDir(recorder: RunRecorder): string {
  return artifactsDir(recorder.projectRoot, recorder.runId)
}
