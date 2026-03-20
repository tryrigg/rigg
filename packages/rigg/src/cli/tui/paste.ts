export type Segment = { kind: "paste"; pasteId: number; text: string } | { kind: "text"; text: string }

const BRACKETED_PASTE_DISABLE = "\u001b[?2004l"
const BRACKETED_PASTE_END = "\u001b[201~"
const BRACKETED_PASTE_END_STRIPPED = "[201~"
const BRACKETED_PASTE_ENABLE = "\u001b[?2004h"
const BRACKETED_PASTE_START = "\u001b[200~"
const BRACKETED_PASTE_START_STRIPPED = "[200~"

let bracketedPasteModeUsers = 0

export function pasteLabel(segment: Extract<Segment, { kind: "paste" }>): string {
  const additionalLines = segment.text.split("\n").length - 1
  return `[Pasted text #${segment.pasteId} +${additionalLines} lines]`
}

export function segmentDisplay(segment: Segment): string {
  return segment.kind === "paste" ? pasteLabel(segment) : segment.text
}

export function normalizeSegments(segments: Segment[]): Segment[] {
  const normalized: Segment[] = []

  for (const segment of segments) {
    if (segment.kind === "text") {
      if (segment.text.length === 0) {
        continue
      }
      const previous = normalized.at(-1)
      if (previous?.kind === "text") {
        previous.text += segment.text
      } else {
        normalized.push({ ...segment })
      }
      continue
    }

    normalized.push({ ...segment })
  }

  return normalized
}

export function createSegments(value: string): Segment[] {
  const normalized = normalizeChunk(value)
  if (normalized.length === 0) {
    return []
  }
  return [{ kind: "text", text: normalized }]
}

export function displayValue(segments: Segment[]): string {
  return segments.map(segmentDisplay).join("")
}

export function expandedValue(segments: Segment[]): string {
  return segments.map((segment) => segment.text).join("")
}

export function reconcileSegments(options: { segments: Segment[]; value: string }): Segment[] {
  const normalizedValue = normalizeChunk(options.value)
  return normalizedValue === expandedValue(options.segments) ? options.segments : createSegments(normalizedValue)
}

export function displayLength(segments: Segment[]): number {
  return displayValue(segments).length
}

export function reconcileState(options: { cursorOffset: number; segments: Segment[]; value: string }): {
  cursorOffset: number
  segments: Segment[]
} {
  const reconciledSegments = reconcileSegments({
    segments: options.segments,
    value: options.value,
  })

  if (reconciledSegments === options.segments) {
    return {
      cursorOffset: options.cursorOffset,
      segments: reconciledSegments,
    }
  }

  return {
    cursorOffset: displayLength(reconciledSegments),
    segments: reconciledSegments,
  }
}

export function detectPaste(input: string): "end" | "start" | undefined {
  switch (input) {
    case BRACKETED_PASTE_START:
    case BRACKETED_PASTE_START_STRIPPED:
      return "start"
    case BRACKETED_PASTE_END:
    case BRACKETED_PASTE_END_STRIPPED:
      return "end"
    default:
      return undefined
  }
}

export function resetTerminal(): void {
  bracketedPasteModeUsers = 0
}

export function acquirePaste(options: { isTTY?: boolean; write: (data: string) => void }): void {
  if (!options.isTTY) {
    return
  }
  if (bracketedPasteModeUsers === 0) {
    options.write(BRACKETED_PASTE_ENABLE)
  }
  bracketedPasteModeUsers += 1
}

export function releasePaste(options: { isTTY?: boolean; write: (data: string) => void }): void {
  if (!options.isTTY || bracketedPasteModeUsers === 0) {
    return
  }
  bracketedPasteModeUsers -= 1
  if (bracketedPasteModeUsers === 0) {
    options.write(BRACKETED_PASTE_DISABLE)
  }
}

export function normalizeChunk(input: string): string {
  return input.replaceAll(BRACKETED_PASTE_START, "").replaceAll(BRACKETED_PASTE_END, "").replace(/\r\n?/g, "\n")
}
