import { dirname, join } from "node:path"

import { resolveDbPath } from "../storage/db"

export const OUTPUT_PREVIEW_MAX_LINES = 2000
export const OUTPUT_PREVIEW_MAX_BYTES = 50 * 1024

export type OutputPreview = {
  preview: string
  truncated: boolean
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

function truncateUtf8(text: string, maxBytes: number): string {
  const raw = Buffer.from(text, "utf8")
  if (raw.length <= maxBytes) {
    return text
  }

  let end = maxBytes
  while (end > 0 && (raw[end]! & 0xc0) === 0x80) {
    end -= 1
  }

  return raw.subarray(0, end).toString("utf8")
}

export function buildOutputPreview(text: string): OutputPreview {
  const lines = text.split("\n")
  const limitedLines = lines.slice(0, OUTPUT_PREVIEW_MAX_LINES)
  const lineLimited = limitedLines.length < lines.length
  const joined = limitedLines.join("\n")
  const preview = truncateUtf8(joined, OUTPUT_PREVIEW_MAX_BYTES)
  return {
    preview,
    truncated: lineLimited || byteLength(preview) < byteLength(text),
  }
}

export function resolveOutputRoot(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(resolveDbPath(env)), "outputs")
}

export function stepOutputPath(
  outputRoot: string,
  runId: string,
  nodePath: string,
  attempt: number,
  stream: "stdout" | "stderr",
): string {
  return join(outputRoot, runId, `${encodeURIComponent(nodePath)}#${attempt}.${stream}.log`)
}
