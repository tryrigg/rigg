import type { Key } from "ink"

import {
  deleteRange,
  deleteWordLeft,
  lineBounds,
  lineColumn,
  lines,
  nextOffset,
  offsetForLineColumn,
  prevOffset,
  snapSegments,
  snapString,
  wordLeft,
  wordRight,
} from "./cursor"
import { displayValue, expandedValue, normalizeChunk, normalizeSegments, segmentDisplay, type Segment } from "./paste"

export type InputKey = {
  backspace?: Key["backspace"]
  ctrl?: Key["ctrl"]
  delete?: Key["delete"]
  downArrow?: Key["downArrow"]
  end?: Key["end"]
  eventType?: Key["eventType"]
  home?: Key["home"]
  leftArrow?: Key["leftArrow"]
  meta?: Key["meta"]
  return?: Key["return"]
  rightArrow?: Key["rightArrow"]
  shift?: Key["shift"]
  tab?: Key["tab"]
  upArrow?: Key["upArrow"]
}

type EditAction =
  | { kind: "noop" }
  | { kind: "submit" }
  | { cursorOffset: number; kind: "update"; preferredColumn: number | null; value: string }

type SegmentsAction =
  | { kind: "noop" }
  | { kind: "submit" }
  | {
      cursorOffset: number
      kind: "update"
      nextPasteId: number
      preferredColumn: number | null
      segments: Segment[]
    }

function matchesCtrlCharacterShortcut(input: string, key: InputKey, shortcut: string): boolean {
  return Boolean(key.ctrl) && input.toLowerCase() === shortcut
}

function isDeleteWordLeftShortcut(input: string, key: InputKey): boolean {
  return ((key.backspace || key.delete) && key.meta) || matchesCtrlCharacterShortcut(input, key, "w")
}

function splitAtOffset(segments: Segment[], cursorOffset: number): { after: Segment[]; before: Segment[] } {
  const safeCursorOffset = snapSegments(segments, cursorOffset, "nearest")
  let displayOffset = 0

  for (const [index, segment] of segments.entries()) {
    const displayVal = segmentDisplay(segment)
    const segmentStart = displayOffset
    const segmentEnd = segmentStart + displayVal.length

    if (safeCursorOffset > segmentEnd) {
      displayOffset = segmentEnd
      continue
    }

    const beforeSegments = segments.slice(0, index)
    const afterSegments = segments.slice(index + 1)

    if (segment.kind === "paste") {
      if (safeCursorOffset <= segmentStart) {
        return { after: [segment, ...afterSegments], before: beforeSegments }
      }
      return { after: afterSegments, before: [...beforeSegments, segment] }
    }

    const relativeOffset = safeCursorOffset - segmentStart
    if (relativeOffset <= 0) {
      return { after: [segment, ...afterSegments], before: beforeSegments }
    }
    if (relativeOffset >= segment.text.length) {
      return { after: afterSegments, before: [...beforeSegments, segment] }
    }

    return {
      after: [{ kind: "text", text: segment.text.slice(relativeOffset) }, ...afterSegments],
      before: [...beforeSegments, { kind: "text", text: segment.text.slice(0, relativeOffset) }],
    }
  }

  return { after: [], before: segments }
}

function insertAtOffset(options: { cursorOffset: number; insertedSegments: Segment[]; segments: Segment[] }): {
  cursorOffset: number
  segments: Segment[]
} {
  const { after, before } = splitAtOffset(options.segments, options.cursorOffset)
  const nextSegments = normalizeSegments([...before, ...options.insertedSegments, ...after])
  const nextCursorOffset = displayValue(normalizeSegments([...before, ...options.insertedSegments])).length

  return {
    cursorOffset: nextCursorOffset,
    segments: nextSegments,
  }
}

function removeDisplayRange(options: { end: number; segments: Segment[]; start: number }): Segment[] {
  const rangeStart = Math.min(options.start, options.end)
  const rangeEnd = Math.max(options.start, options.end)
  if (rangeStart === rangeEnd) {
    return options.segments
  }

  let displayOffset = 0
  const nextSegments: Segment[] = []

  for (const segment of options.segments) {
    const displayVal = segmentDisplay(segment)
    const segmentStart = displayOffset
    const segmentEnd = segmentStart + displayVal.length
    displayOffset = segmentEnd

    if (segment.kind === "paste") {
      if (rangeEnd <= segmentStart || rangeStart >= segmentEnd) {
        nextSegments.push(segment)
      }
      continue
    }

    if (rangeEnd <= segmentStart || rangeStart >= segmentEnd) {
      nextSegments.push(segment)
      continue
    }

    const cutStart = Math.max(0, rangeStart - segmentStart)
    const cutEnd = Math.max(cutStart, Math.min(segment.text.length, rangeEnd - segmentStart))
    const nextText = segment.text.slice(0, cutStart) + segment.text.slice(cutEnd)
    if (nextText.length > 0) {
      nextSegments.push({ kind: "text", text: nextText })
    }
  }

  return normalizeSegments(nextSegments)
}

function deleteDisplayRange(options: { cursorOffset: number; end: number; segments: Segment[]; start: number }): {
  cursorOffset: number
  segments: Segment[]
} {
  return {
    cursorOffset: snapSegments(options.segments, Math.min(options.start, options.end), "left"),
    segments: removeDisplayRange(options),
  }
}

export function applyKey(options: {
  cursorOffset: number
  input: string
  key: InputKey
  preferredColumn?: number | null
  value: string
}): EditAction {
  const value = normalizeChunk(options.value)
  const cursorOffset = snapString(value, options.cursorOffset, "nearest")
  const { input, key } = options
  const metaShortcut = key.meta ? input.toLowerCase() : input

  if (key.eventType === "release") {
    return { kind: "noop" }
  }

  if ((key.ctrl && input === "c") || key.tab) {
    return { kind: "noop" }
  }

  if (key.return && !key.shift) {
    return { kind: "submit" }
  }

  if (key.meta && metaShortcut === "b") {
    return {
      cursorOffset: wordLeft(value, cursorOffset),
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (key.meta && metaShortcut === "f") {
    return {
      cursorOffset: wordRight(value, cursorOffset),
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (matchesCtrlCharacterShortcut(input, key, "a") || key.home) {
    return {
      cursorOffset: lineBounds(value, cursorOffset).start,
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (matchesCtrlCharacterShortcut(input, key, "e") || key.end) {
    return {
      cursorOffset: lineBounds(value, cursorOffset).end,
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (isDeleteWordLeftShortcut(input, key)) {
    const deleted = deleteWordLeft(value, cursorOffset)
    if (deleted.value === value) {
      return { kind: "noop" }
    }
    return {
      cursorOffset: deleted.cursorOffset,
      kind: "update",
      preferredColumn: null,
      value: deleted.value,
    }
  }

  if (key.leftArrow) {
    const nextCursorOffset = key.meta ? wordLeft(value, cursorOffset) : prevOffset(value, cursorOffset)
    return {
      cursorOffset: nextCursorOffset,
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (key.rightArrow) {
    const nextCursorOffset = key.meta ? wordRight(value, cursorOffset) : nextOffset(value, cursorOffset)
    return {
      cursorOffset: nextCursorOffset,
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (key.upArrow || key.downArrow) {
    const { column, lineIndex } = lineColumn(value, cursorOffset)
    const targetLineIndex = key.upArrow ? lineIndex - 1 : lineIndex + 1
    if (targetLineIndex < 0 || targetLineIndex >= lines(value).length) {
      return { kind: "noop" }
    }
    const preferredColumn = options.preferredColumn ?? column
    return {
      cursorOffset: offsetForLineColumn(value, targetLineIndex, preferredColumn),
      kind: "update",
      preferredColumn,
      value,
    }
  }

  if (key.backspace || key.delete) {
    const dr = deleteRange({
      cursorOffset,
      value,
    })

    if (dr === undefined) {
      return { kind: "noop" }
    }

    return {
      cursorOffset: dr.start,
      kind: "update",
      preferredColumn: null,
      value: value.slice(0, dr.start) + value.slice(dr.end),
    }
  }

  const inserted = key.return && key.shift ? "\n" : normalizeChunk(input)
  if (inserted.length === 0) {
    return { kind: "noop" }
  }

  return {
    cursorOffset: cursorOffset + inserted.length,
    kind: "update",
    preferredColumn: null,
    value: value.slice(0, cursorOffset) + inserted + value.slice(cursorOffset),
  }
}

export function applySegmentsKey(options: {
  cursorOffset: number
  input: string
  key: InputKey
  nextPasteId: number
  preferredColumn?: number | null
  segments: Segment[]
  treatAsPaste?: boolean
}): SegmentsAction {
  const { input, key } = options

  if (key.eventType === "release") {
    return { kind: "noop" }
  }

  if ((key.ctrl && input === "c") || key.tab) {
    return { kind: "noop" }
  }

  if (key.return && !key.shift) {
    return { kind: "submit" }
  }

  const segments = normalizeSegments(options.segments)
  const value = displayValue(segments)
  const cursorOffset = snapSegments(segments, options.cursorOffset, "nearest")
  const metaShortcut = key.meta ? input.toLowerCase() : input

  if (key.meta && metaShortcut === "b") {
    return {
      cursorOffset: snapSegments(segments, wordLeft(value, cursorOffset), "left"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (key.meta && metaShortcut === "f") {
    return {
      cursorOffset: snapSegments(segments, wordRight(value, cursorOffset), "right"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (matchesCtrlCharacterShortcut(input, key, "a") || key.home) {
    return {
      cursorOffset: lineBounds(value, cursorOffset).start,
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (matchesCtrlCharacterShortcut(input, key, "e") || key.end) {
    return {
      cursorOffset: lineBounds(value, cursorOffset).end,
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (isDeleteWordLeftShortcut(input, key)) {
    const next = deleteDisplayRange({
      cursorOffset,
      end: cursorOffset,
      segments,
      start: wordLeft(value, cursorOffset),
    })
    if (displayValue(next.segments) === value && expandedValue(next.segments) === expandedValue(segments)) {
      return { kind: "noop" }
    }
    return {
      cursorOffset: next.cursorOffset,
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments: next.segments,
    }
  }

  if (key.leftArrow) {
    const nextCursorOffset = key.meta ? wordLeft(value, cursorOffset) : prevOffset(value, cursorOffset)
    return {
      cursorOffset: snapSegments(segments, nextCursorOffset, "left"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (key.rightArrow) {
    const nextCursorOffset = key.meta ? wordRight(value, cursorOffset) : nextOffset(value, cursorOffset)
    return {
      cursorOffset: snapSegments(segments, nextCursorOffset, "right"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (key.upArrow || key.downArrow) {
    const { column, lineIndex } = lineColumn(value, cursorOffset)
    const targetLineIndex = key.upArrow ? lineIndex - 1 : lineIndex + 1
    if (targetLineIndex < 0 || targetLineIndex >= lines(value).length) {
      return { kind: "noop" }
    }
    const preferredColumn = options.preferredColumn ?? column
    return {
      cursorOffset: snapSegments(segments, offsetForLineColumn(value, targetLineIndex, preferredColumn), "nearest"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn,
      segments,
    }
  }

  if (key.backspace || key.delete) {
    const dr = deleteRange({
      cursorOffset,
      value,
    })

    if (dr === undefined) {
      return { kind: "noop" }
    }

    const next = deleteDisplayRange({
      cursorOffset: dr.start,
      end: dr.end,
      segments,
      start: dr.start,
    })
    return {
      cursorOffset: next.cursorOffset,
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments: next.segments,
    }
  }

  const inserted = key.return && key.shift ? "\n" : normalizeChunk(input)
  if (inserted.length === 0) {
    return { kind: "noop" }
  }

  const isPaste = options.treatAsPaste === true && !key.return && inserted.includes("\n")
  const insertedSegments = isPaste
    ? [{ kind: "paste", pasteId: options.nextPasteId, text: inserted } satisfies Segment]
    : [{ kind: "text", text: inserted } satisfies Segment]
  const next = insertAtOffset({
    cursorOffset,
    insertedSegments,
    segments,
  })

  return {
    cursorOffset: next.cursorOffset,
    kind: "update",
    nextPasteId: isPaste ? options.nextPasteId + 1 : options.nextPasteId,
    preferredColumn: null,
    segments: next.segments,
  }
}

export type { EditAction, SegmentsAction }
