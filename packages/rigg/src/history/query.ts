import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"

import { parseJson } from "../util/json"
import { normalizeError } from "../util/error"
import { decodeRunSnapshot } from "./decode"
import {
  compareParsedLogFileName,
  isRunDirectoryName,
  logsDir,
  parseLogFileName,
  runsDir,
  statePath,
  type LogStream,
} from "./fs"
import type { RunSnapshot } from "./schema"

export type ReadLogsResult = { kind: "found"; output: string } | { kind: "not_found"; message: string }

export async function readRunSnapshot(projectRoot: string, runId: string): Promise<RunSnapshot> {
  const path = statePath(projectRoot, runId)
  const text = await Bun.file(path).text()
  return decodeRunSnapshot(parseJson(text), path)
}

export async function readStatuses(projectRoot: string, runId?: string): Promise<RunSnapshot[]> {
  try {
    if (runId !== undefined) {
      const path = statePath(projectRoot, runId)
      try {
        const text = await Bun.file(path).text()
        return [decodeRunSnapshot(parseJson(text), path)]
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          return []
        }
        throw error
      }
    }

    const root = runsDir(projectRoot)
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return []
      }
      throw error
    })

    const snapshots: RunSnapshot[] = []
    const directories = entries
      .filter((entry) => entry.isDirectory() && isRunDirectoryName(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse()

    for (const directory of directories) {
      const path = join(root, directory, "state.json")
      let text: string
      try {
        text = await Bun.file(path).text()
      } catch (error) {
        if (isErrnoException(error) && error.code === "ENOENT") {
          continue
        }
        throw error
      }

      snapshots.push(decodeRunSnapshot(parseJson(text), path))
    }

    return snapshots
  } catch (error) {
    throw normalizeError(error)
  }
}

export async function readLogs(
  projectRoot: string,
  runId: string,
  selection: {
    node?: string
    stream: LogStream
  },
): Promise<ReadLogsResult> {
  try {
    const directory = logsDir(projectRoot, runId)
    const entries = await readdir(directory, { withFileTypes: true })
    let selectedNodePath = selection.node

    if (selectedNodePath !== undefined && !selectedNodePath.startsWith("/")) {
      const snapshot = await readRunSnapshot(projectRoot, runId)
      selectedNodePath = snapshot.nodes.find((node) => node.user_id === selection.node)?.node_path
    }

    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => parseLogFileName(entry.name))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .filter((entry) => entry.stream === selection.stream)
      .filter((entry) => selectedNodePath === undefined || entry.nodePath === selectedNodePath)
      .sort(compareParsedLogFileName)

    if (files.length === 0) {
      return { kind: "not_found", message: "node log matching selection was not found" }
    }

    const output: string[] = []
    for (const file of files) {
      const path = join(directory, file.fileName)
      const text = await Bun.file(path).text()
      output.push(`== ${basename(path)} ==\n${text.endsWith("\n") ? text : `${text}\n`}`)
    }

    return { kind: "found", output: output.join("") }
  } catch (error) {
    throw normalizeError(error)
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
