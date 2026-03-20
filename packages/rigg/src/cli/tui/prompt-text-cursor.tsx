import type { ReactNode } from "react"
import { Text } from "ink"

import {
  getPromptTextInputDisplayValue,
  getPromptTextInputSegmentDisplayValue,
  type PromptTextInputSegment,
} from "./prompt-text-paste"

const promptTextInputGraphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined

type PromptLine = {
  length: number
  start: number
}

export function clampCursorOffset(value: string, cursorOffset: number): number {
  return Math.max(0, Math.min(cursorOffset, value.length))
}

export function getPromptTextInputCharacterBoundaries(value: string): number[] {
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

export function getPromptTextInputBoundaryIndex(boundaries: number[], cursorOffset: number): number {
  const boundaryIndex = boundaries.indexOf(cursorOffset)
  return boundaryIndex === -1 ? 0 : boundaryIndex
}

export function getPromptTextInputCharacterCount(value: string): number {
  return Math.max(0, getPromptTextInputCharacterBoundaries(value).length - 1)
}

export function getPromptTextInputOffsetForCharacterIndex(value: string, characterIndex: number): number {
  const boundaries = getPromptTextInputCharacterBoundaries(value)
  return boundaries[Math.max(0, Math.min(characterIndex, boundaries.length - 1))] ?? value.length
}

export function snapPromptTextInputStringCursorOffset(
  value: string,
  cursorOffset: number,
  direction: "left" | "nearest" | "right",
): number {
  const boundaries = getPromptTextInputCharacterBoundaries(value)
  const safeCursorOffset = clampCursorOffset(value, cursorOffset)

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

export function getPromptTextInputPreviousCursorOffset(value: string, cursorOffset: number): number {
  const safeCursorOffset = clampCursorOffset(value, cursorOffset)
  const boundaries = getPromptTextInputCharacterBoundaries(value)

  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index]
    if (boundary !== undefined && boundary < safeCursorOffset) {
      return boundary
    }
  }

  return 0
}

export function getPromptTextInputNextCursorOffset(value: string, cursorOffset: number): number {
  const safeCursorOffset = clampCursorOffset(value, cursorOffset)

  for (const boundary of getPromptTextInputCharacterBoundaries(value)) {
    if (boundary > safeCursorOffset) {
      return boundary
    }
  }

  return value.length
}

export function getPromptTextInputCharacterByBoundaryIndex(
  value: string,
  boundaries: number[],
  boundaryIndex: number,
): string {
  const start = boundaries[boundaryIndex] ?? value.length
  const end = boundaries[boundaryIndex + 1] ?? start
  return value.slice(start, end)
}

export function getPromptTextInputCharacterAt(value: string, cursorOffset: number): string | undefined {
  const safeCursorOffset = snapPromptTextInputStringCursorOffset(value, cursorOffset, "nearest")
  const boundaries = getPromptTextInputCharacterBoundaries(value)
  const boundaryIndex = getPromptTextInputBoundaryIndex(boundaries, safeCursorOffset)

  if (boundaryIndex >= boundaries.length - 1) {
    return undefined
  }

  return getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex)
}

export function getPromptLines(value: string): PromptLine[] {
  const lines = value.split("\n")
  let start = 0
  return lines.map((line) => {
    const promptLine = { length: line.length, start }
    start += line.length + 1
    return promptLine
  })
}

export function getCursorLineColumn(value: string, cursorOffset: number): { column: number; lineIndex: number } {
  const safeCursorOffset = snapPromptTextInputStringCursorOffset(value, cursorOffset, "nearest")
  const lines = getPromptLines(value)

  for (const [lineIndex, line] of lines.entries()) {
    const lineEnd = line.start + line.length
    if (safeCursorOffset <= lineEnd) {
      return {
        column: getPromptTextInputCharacterCount(value.slice(line.start, safeCursorOffset)),
        lineIndex,
      }
    }
  }

  const lastLine = lines.at(-1) ?? { length: 0, start: 0 }
  return {
    column: getPromptTextInputCharacterCount(value.slice(lastLine.start, lastLine.start + lastLine.length)),
    lineIndex: Math.max(0, lines.length - 1),
  }
}

export function getCursorOffsetForLineColumn(value: string, lineIndex: number, column: number): number {
  const lines = getPromptLines(value)
  const line = lines[lineIndex]
  if (line === undefined) {
    return clampCursorOffset(value, value.length)
  }
  const lineValue = value.slice(line.start, line.start + line.length)
  return clampCursorOffset(value, line.start + getPromptTextInputOffsetForCharacterIndex(lineValue, column))
}

export function getCurrentLineBounds(value: string, cursorOffset: number): { end: number; start: number } {
  const { lineIndex } = getCursorLineColumn(value, cursorOffset)
  const line = getPromptLines(value)[lineIndex]
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

export function findWordBoundaryLeft(value: string, cursorOffset: number): number {
  const boundaries = getPromptTextInputCharacterBoundaries(value)
  const safeCursorOffset = snapPromptTextInputStringCursorOffset(value, cursorOffset, "nearest")
  let boundaryIndex = getPromptTextInputBoundaryIndex(boundaries, safeCursorOffset)

  if (boundaryIndex === 0) {
    return 0
  }

  while (
    boundaryIndex > 0 &&
    /\s/.test(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex - 1))
  ) {
    boundaryIndex -= 1
  }
  if (boundaryIndex === 0) {
    return 0
  }

  const kind = classifyPromptCharacter(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex - 1))
  while (
    boundaryIndex > 0 &&
    classifyPromptCharacter(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex - 1)) === kind
  ) {
    boundaryIndex -= 1
  }

  return boundaries[boundaryIndex] ?? 0
}

export function findWordBoundaryRight(value: string, cursorOffset: number): number {
  const boundaries = getPromptTextInputCharacterBoundaries(value)
  let boundaryIndex = getPromptTextInputBoundaryIndex(
    boundaries,
    snapPromptTextInputStringCursorOffset(value, cursorOffset, "nearest"),
  )

  while (
    boundaryIndex < boundaries.length - 1 &&
    /\s/.test(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex))
  ) {
    boundaryIndex += 1
  }

  if (boundaryIndex >= boundaries.length - 1) {
    return value.length
  }

  const kind = classifyPromptCharacter(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex))
  while (
    boundaryIndex < boundaries.length - 1 &&
    classifyPromptCharacter(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex)) === kind
  ) {
    boundaryIndex += 1
  }

  return boundaries[boundaryIndex] ?? value.length
}

export function deleteWordLeft(value: string, cursorOffset: number): { cursorOffset: number; value: string } {
  const safeCursorOffset = snapPromptTextInputStringCursorOffset(value, cursorOffset, "nearest")
  if (safeCursorOffset === 0) {
    return { cursorOffset: 0, value }
  }

  const nextCursorOffset = findWordBoundaryLeft(value, safeCursorOffset)
  return {
    cursorOffset: nextCursorOffset,
    value: value.slice(0, nextCursorOffset) + value.slice(safeCursorOffset),
  }
}

export function getPromptTextInputDeleteRange(options: {
  cursorOffset: number
  value: string
}): { end: number; start: number } | undefined {
  const safeCursorOffset = snapPromptTextInputStringCursorOffset(options.value, options.cursorOffset, "nearest")
  const previousCursorOffset = getPromptTextInputPreviousCursorOffset(options.value, safeCursorOffset)
  if (previousCursorOffset === safeCursorOffset) {
    return undefined
  }

  return {
    end: safeCursorOffset,
    start: previousCursorOffset,
  }
}

export function snapPromptTextInputCursorOffset(
  segments: PromptTextInputSegment[],
  cursorOffset: number,
  direction: "left" | "nearest" | "right",
): number {
  const safeCursorOffset = snapPromptTextInputStringCursorOffset(
    getPromptTextInputDisplayValue(segments),
    cursorOffset,
    direction,
  )
  let displayOffset = 0

  for (const segment of segments) {
    const displayValue = getPromptTextInputSegmentDisplayValue(segment)
    const segmentStart = displayOffset
    const segmentEnd = segmentStart + displayValue.length

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

export function renderPromptTextValue(value: string, cursorOffset: number): ReactNode {
  const safeCursorOffset = snapPromptTextInputStringCursorOffset(value, cursorOffset, "nearest")
  const beforeCursor = value.slice(0, safeCursorOffset)
  const activeCharacter = getPromptTextInputCharacterAt(value, safeCursorOffset)
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
