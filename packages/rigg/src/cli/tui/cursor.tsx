import type { ReactNode } from "react"
import { Text } from "ink"

import { displayValue, segmentDisplay, type Segment } from "./paste"

const promptTextInputGraphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined

type PromptLine = {
  length: number
  start: number
}

export function clamp(value: string, cursorOffset: number): number {
  return Math.max(0, Math.min(cursorOffset, value.length))
}

export function charBoundaries(value: string): number[] {
  const boundaries = [0]
  let offset = 0

  if (promptTextInputGraphemeSegmenter === undefined) {
    for (const character of value) {
      offset += character.length
      boundaries.push(offset)
    }
    return boundaries
  }

  for (const { segment } of promptTextInputGraphemeSegmenter.segment(value)) {
    offset += segment.length
    boundaries.push(offset)
  }

  return boundaries
}

export function boundaryIndex(boundaries: number[], cursorOffset: number): number {
  const idx = boundaries.indexOf(cursorOffset)
  return idx === -1 ? 0 : idx
}

export function charCount(value: string): number {
  return Math.max(0, charBoundaries(value).length - 1)
}

export function offsetForChar(value: string, characterIndex: number): number {
  const boundaries = charBoundaries(value)
  return boundaries[Math.max(0, Math.min(characterIndex, boundaries.length - 1))] ?? value.length
}

export function snapString(value: string, cursorOffset: number, direction: "left" | "nearest" | "right"): number {
  const boundaries = charBoundaries(value)
  const safeCursorOffset = clamp(value, cursorOffset)

  for (const [index, boundary] of boundaries.entries()) {
    if (boundary === safeCursorOffset) {
      return boundary
    }

    if (boundary > safeCursorOffset) {
      const previousBoundary = boundaries[index - 1] ?? 0
      if (direction === "left") {
        return previousBoundary
      }
      if (direction === "right") {
        return boundary
      }
      return safeCursorOffset - previousBoundary <= boundary - safeCursorOffset ? previousBoundary : boundary
    }
  }

  return safeCursorOffset
}

export function prevOffset(value: string, cursorOffset: number): number {
  const safeCursorOffset = clamp(value, cursorOffset)
  const boundaries = charBoundaries(value)

  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index]
    if (boundary !== undefined && boundary < safeCursorOffset) {
      return boundary
    }
  }

  return 0
}

export function nextOffset(value: string, cursorOffset: number): number {
  const safeCursorOffset = clamp(value, cursorOffset)

  for (const boundary of charBoundaries(value)) {
    if (boundary > safeCursorOffset) {
      return boundary
    }
  }

  return value.length
}

export function charByBoundaryIndex(value: string, boundaries: number[], boundaryIndex: number): string {
  const start = boundaries[boundaryIndex] ?? value.length
  const end = boundaries[boundaryIndex + 1] ?? start
  return value.slice(start, end)
}

export function charAt(value: string, cursorOffset: number): string | undefined {
  const safeCursorOffset = snapString(value, cursorOffset, "nearest")
  const boundaries = charBoundaries(value)
  const idx = boundaryIndex(boundaries, safeCursorOffset)

  if (idx >= boundaries.length - 1) {
    return undefined
  }

  return charByBoundaryIndex(value, boundaries, idx)
}

export function lines(value: string): PromptLine[] {
  const splitLines = value.split("\n")
  let start = 0
  return splitLines.map((line) => {
    const promptLine = { length: line.length, start }
    start += line.length + 1
    return promptLine
  })
}

export function lineColumn(value: string, cursorOffset: number): { column: number; lineIndex: number } {
  const safeCursorOffset = snapString(value, cursorOffset, "nearest")
  const promptLines = lines(value)

  for (const [lineIndex, line] of promptLines.entries()) {
    const lineEnd = line.start + line.length
    if (safeCursorOffset <= lineEnd) {
      return {
        column: charCount(value.slice(line.start, safeCursorOffset)),
        lineIndex,
      }
    }
  }

  const lastLine = promptLines.at(-1) ?? { length: 0, start: 0 }
  return {
    column: charCount(value.slice(lastLine.start, lastLine.start + lastLine.length)),
    lineIndex: Math.max(0, promptLines.length - 1),
  }
}

export function offsetForLineColumn(value: string, lineIndex: number, column: number): number {
  const promptLines = lines(value)
  const line = promptLines[lineIndex]
  if (line === undefined) {
    return clamp(value, value.length)
  }
  const lineValue = value.slice(line.start, line.start + line.length)
  return clamp(value, line.start + offsetForChar(lineValue, column))
}

export function lineBounds(value: string, cursorOffset: number): { end: number; start: number } {
  const { lineIndex } = lineColumn(value, cursorOffset)
  const line = lines(value)[lineIndex]
  if (line === undefined) {
    return { end: 0, start: 0 }
  }
  return {
    end: line.start + line.length,
    start: line.start,
  }
}

function classifyPromptCharacter(char: string): "punctuation" | "space" | "word" {
  if (/\s/.test(char)) {
    return "space"
  }
  if (/[A-Za-z0-9_]/.test(char)) {
    return "word"
  }
  return "punctuation"
}

export function wordLeft(value: string, cursorOffset: number): number {
  const boundaries = charBoundaries(value)
  const safeCursorOffset = snapString(value, cursorOffset, "nearest")
  let idx = boundaryIndex(boundaries, safeCursorOffset)

  if (idx === 0) {
    return 0
  }

  while (idx > 0 && /\s/.test(charByBoundaryIndex(value, boundaries, idx - 1))) {
    idx -= 1
  }
  if (idx === 0) {
    return 0
  }

  const kind = classifyPromptCharacter(charByBoundaryIndex(value, boundaries, idx - 1))
  while (idx > 0 && classifyPromptCharacter(charByBoundaryIndex(value, boundaries, idx - 1)) === kind) {
    idx -= 1
  }

  return boundaries[idx] ?? 0
}

export function wordRight(value: string, cursorOffset: number): number {
  const boundaries = charBoundaries(value)
  let idx = boundaryIndex(boundaries, snapString(value, cursorOffset, "nearest"))

  while (idx < boundaries.length - 1 && /\s/.test(charByBoundaryIndex(value, boundaries, idx))) {
    idx += 1
  }

  if (idx >= boundaries.length - 1) {
    return value.length
  }

  const kind = classifyPromptCharacter(charByBoundaryIndex(value, boundaries, idx))
  while (idx < boundaries.length - 1 && classifyPromptCharacter(charByBoundaryIndex(value, boundaries, idx)) === kind) {
    idx += 1
  }

  return boundaries[idx] ?? value.length
}

export function deleteWordLeft(value: string, cursorOffset: number): { cursorOffset: number; value: string } {
  const safeCursorOffset = snapString(value, cursorOffset, "nearest")
  if (safeCursorOffset === 0) {
    return { cursorOffset: 0, value }
  }

  const nextCursorOffset = wordLeft(value, safeCursorOffset)
  return {
    cursorOffset: nextCursorOffset,
    value: value.slice(0, nextCursorOffset) + value.slice(safeCursorOffset),
  }
}

export function deleteRange(options: {
  cursorOffset: number
  value: string
}): { end: number; start: number } | undefined {
  const safeCursorOffset = snapString(options.value, options.cursorOffset, "nearest")
  const previousCursorOffset = prevOffset(options.value, safeCursorOffset)
  if (previousCursorOffset === safeCursorOffset) {
    return undefined
  }

  return {
    end: safeCursorOffset,
    start: previousCursorOffset,
  }
}

export function snapSegments(
  segments: Segment[],
  cursorOffset: number,
  direction: "left" | "nearest" | "right",
): number {
  const safeCursorOffset = snapString(displayValue(segments), cursorOffset, direction)
  let displayOffset = 0

  for (const segment of segments) {
    const dv = segmentDisplay(segment)
    const segmentStart = displayOffset
    const segmentEnd = segmentStart + dv.length

    if (safeCursorOffset < segmentStart) {
      return safeCursorOffset
    }

    if (segment.kind === "text") {
      if (safeCursorOffset <= segmentEnd) {
        return safeCursorOffset
      }
    } else if (safeCursorOffset > segmentStart && safeCursorOffset < segmentEnd) {
      if (direction === "left") {
        return segmentStart
      }
      if (direction === "right") {
        return segmentEnd
      }
      return safeCursorOffset - segmentStart < segmentEnd - safeCursorOffset ? segmentStart : segmentEnd
    } else if (safeCursorOffset <= segmentEnd) {
      return safeCursorOffset
    }

    displayOffset = segmentEnd
  }

  return safeCursorOffset
}

export function renderValue(value: string, cursorOffset: number): ReactNode {
  const safeCursorOffset = snapString(value, cursorOffset, "nearest")
  const beforeCursor = value.slice(0, safeCursorOffset)
  const activeCharacter = charAt(value, safeCursorOffset)
  const afterCursor = activeCharacter === undefined ? "" : value.slice(safeCursorOffset + activeCharacter.length)

  if (activeCharacter === undefined) {
    return (
      <>
        {beforeCursor}
        <Text inverse> </Text>
      </>
    )
  }

  if (activeCharacter === "\n") {
    return (
      <>
        {beforeCursor}
        <Text inverse> </Text>
        {"\n"}
        {afterCursor}
      </>
    )
  }

  return (
    <>
      {beforeCursor}
      <Text inverse>{activeCharacter}</Text>
      {afterCursor}
    </>
  )
}
