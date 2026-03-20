export type PromptTextInputSegment = { kind: "paste"; pasteId: number; text: string } | { kind: "text"; text: string }

const BRACKETED_PASTE_DISABLE = "\u001b[?2004l"
const BRACKETED_PASTE_END = "\u001b[201~"
const BRACKETED_PASTE_END_STRIPPED = "[201~"
const BRACKETED_PASTE_ENABLE = "\u001b[?2004h"
const BRACKETED_PASTE_START = "\u001b[200~"
const BRACKETED_PASTE_START_STRIPPED = "[200~"

let bracketedPasteModeUsers = 0

export function getPromptTextInputPasteLabel(segment: Extract<PromptTextInputSegment, { kind: "paste" }>): string {
  const additionalLines = segment.text.split("\n").length - 1
  return `[Pasted text #${segment.pasteId} +${additionalLines} lines]`
}

export function getPromptTextInputSegmentDisplayValue(segment: PromptTextInputSegment): string {
  return segment.kind === "paste" ? getPromptTextInputPasteLabel(segment) : segment.text
}

export function normalizePromptTextInputSegments(segments: PromptTextInputSegment[]): PromptTextInputSegment[] {
  const normalized: PromptTextInputSegment[] = []

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

export function createPromptTextInputSegments(value: string): PromptTextInputSegment[] {
  const normalized = normalizePromptInputChunk(value)
  if (normalized.length === 0) {
    return []
  }
  return [{ kind: "text", text: normalized }]
}

export function getPromptTextInputDisplayValue(segments: PromptTextInputSegment[]): string {
  return segments.map(getPromptTextInputSegmentDisplayValue).join("")
}

export function getPromptTextInputExpandedValue(segments: PromptTextInputSegment[]): string {
  return segments.map((segment) => segment.text).join("")
}

export function reconcilePromptTextInputSegments(options: {
  segments: PromptTextInputSegment[]
  value: string
}): PromptTextInputSegment[] {
  const normalizedValue = normalizePromptInputChunk(options.value)
  return normalizedValue === getPromptTextInputExpandedValue(options.segments)
    ? options.segments
    : createPromptTextInputSegments(normalizedValue)
}

export function getPromptTextInputDisplayLength(segments: PromptTextInputSegment[]): number {
  return getPromptTextInputDisplayValue(segments).length
}

export function reconcilePromptTextInputControlledState(options: {
  cursorOffset: number
  segments: PromptTextInputSegment[]
  value: string
}): { cursorOffset: number; segments: PromptTextInputSegment[] } {
  const reconciledSegments = reconcilePromptTextInputSegments({
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
    cursorOffset: getPromptTextInputDisplayLength(reconciledSegments),
    segments: reconciledSegments,
  }
}

export function detectPromptPasteControl(input: string): "end" | "start" | undefined {
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

export function resetPromptTextInputTerminalState(): void {
  bracketedPasteModeUsers = 0
}

export function acquirePromptTextInputBracketedPaste(options: {
  isTTY?: boolean
  write: (data: string) => void
}): void {
  if (!options.isTTY) {
    return
  }
  if (bracketedPasteModeUsers === 0) {
    options.write(BRACKETED_PASTE_ENABLE)
  }
  bracketedPasteModeUsers += 1
}

export function releasePromptTextInputBracketedPaste(options: {
  isTTY?: boolean
  write: (data: string) => void
}): void {
  if (!options.isTTY || bracketedPasteModeUsers === 0) {
    return
  }
  bracketedPasteModeUsers -= 1
  if (bracketedPasteModeUsers === 0) {
    options.write(BRACKETED_PASTE_DISABLE)
  }
}

export function normalizePromptInputChunk(input: string): string {
  return input.replaceAll(BRACKETED_PASTE_START, "").replaceAll(BRACKETED_PASTE_END, "").replace(/\r\n?/g, "\n")
}
