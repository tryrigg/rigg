import type { Key } from "ink"

import {
  deleteWordLeft,
  findWordBoundaryLeft,
  findWordBoundaryRight,
  getCurrentLineBounds,
  getCursorLineColumn,
  getCursorOffsetForLineColumn,
  getPromptLines,
  getPromptTextInputDeleteRange,
  getPromptTextInputNextCursorOffset,
  getPromptTextInputPreviousCursorOffset,
  snapPromptTextInputCursorOffset,
  snapPromptTextInputStringCursorOffset,
} from "./prompt-text-cursor"
import {
  getPromptTextInputDisplayValue,
  getPromptTextInputExpandedValue,
  getPromptTextInputSegmentDisplayValue,
  normalizePromptInputChunk,
  normalizePromptTextInputSegments,
  type PromptTextInputSegment,
} from "./prompt-text-paste"

export type PromptTextInputKey = Pick<
  Key,
  | "backspace"
  | "ctrl"
  | "delete"
  | "downArrow"
  | "end"
  | "eventType"
  | "home"
  | "leftArrow"
  | "meta"
  | "return"
  | "rightArrow"
  | "shift"
  | "tab"
  | "upArrow"
>

type PromptTextInputAction =
  | { kind: "noop" }
  | { kind: "submit" }
  | { cursorOffset: number; kind: "update"; preferredColumn: number | null; value: string }

type PromptTextInputSegmentsAction =
  | { kind: "noop" }
  | { kind: "submit" }
  | {
      cursorOffset: number
      kind: "update"
      nextPasteId: number
      preferredColumn: number | null
      segments: PromptTextInputSegment[]
    }

function matchesCtrlCharacterShortcut(input: string, key: PromptTextInputKey, shortcut: string): boolean {
  return key.ctrl && input.toLowerCase() === shortcut
}

function isDeleteWordLeftShortcut(input: string, key: PromptTextInputKey): boolean {
  return ((key.backspace || key.delete) && key.meta) || matchesCtrlCharacterShortcut(input, key, "w")
}

function splitPromptTextInputSegmentsAtDisplayOffset(
  segments: PromptTextInputSegment[],
  cursorOffset: number,
): { after: PromptTextInputSegment[]; before: PromptTextInputSegment[] } {
  const safeCursorOffset = snapPromptTextInputCursorOffset(segments, cursorOffset, "nearest")
  let displayOffset = 0

  for (const [index, segment] of segments.entries()) {
    const displayValue = getPromptTextInputSegmentDisplayValue(segment)
    const segmentStart = displayOffset
    const segmentEnd = segmentStart + displayValue.length

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

function insertPromptTextInputSegmentsAtDisplayOffset(options: {
  cursorOffset: number
  insertedSegments: PromptTextInputSegment[]
  segments: PromptTextInputSegment[]
}): { cursorOffset: number; segments: PromptTextInputSegment[] } {
  const { after, before } = splitPromptTextInputSegmentsAtDisplayOffset(options.segments, options.cursorOffset)
  const nextSegments = normalizePromptTextInputSegments([...before, ...options.insertedSegments, ...after])
  const nextCursorOffset = getPromptTextInputDisplayValue(
    normalizePromptTextInputSegments([...before, ...options.insertedSegments]),
  ).length

  return {
    cursorOffset: nextCursorOffset,
    segments: nextSegments,
  }
}

function removePromptTextInputDisplayRange(options: {
  end: number
  segments: PromptTextInputSegment[]
  start: number
}): PromptTextInputSegment[] {
  const rangeStart = Math.min(options.start, options.end)
  const rangeEnd = Math.max(options.start, options.end)
  if (rangeStart === rangeEnd) {
    return options.segments
  }

  let displayOffset = 0
  const nextSegments: PromptTextInputSegment[] = []

  for (const segment of options.segments) {
    const displayValue = getPromptTextInputSegmentDisplayValue(segment)
    const segmentStart = displayOffset
    const segmentEnd = segmentStart + displayValue.length
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

  return normalizePromptTextInputSegments(nextSegments)
}

function deletePromptTextInputDisplayRange(options: {
  cursorOffset: number
  end: number
  segments: PromptTextInputSegment[]
  start: number
}): { cursorOffset: number; segments: PromptTextInputSegment[] } {
  return {
    cursorOffset: snapPromptTextInputCursorOffset(options.segments, Math.min(options.start, options.end), "left"),
    segments: removePromptTextInputDisplayRange(options),
  }
}

export function applyPromptTextInputKey(options: {
  cursorOffset: number
  input: string
  key: PromptTextInputKey
  preferredColumn?: number | null
  value: string
}): PromptTextInputAction {
  const value = normalizePromptInputChunk(options.value)
  const cursorOffset = snapPromptTextInputStringCursorOffset(value, options.cursorOffset, "nearest")
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
      cursorOffset: findWordBoundaryLeft(value, cursorOffset),
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (key.meta && metaShortcut === "f") {
    return {
      cursorOffset: findWordBoundaryRight(value, cursorOffset),
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (matchesCtrlCharacterShortcut(input, key, "a") || key.home) {
    return {
      cursorOffset: getCurrentLineBounds(value, cursorOffset).start,
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (matchesCtrlCharacterShortcut(input, key, "e") || key.end) {
    return {
      cursorOffset: getCurrentLineBounds(value, cursorOffset).end,
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
    const nextCursorOffset = key.meta
      ? findWordBoundaryLeft(value, cursorOffset)
      : getPromptTextInputPreviousCursorOffset(value, cursorOffset)
    return {
      cursorOffset: nextCursorOffset,
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (key.rightArrow) {
    const nextCursorOffset = key.meta
      ? findWordBoundaryRight(value, cursorOffset)
      : getPromptTextInputNextCursorOffset(value, cursorOffset)
    return {
      cursorOffset: nextCursorOffset,
      kind: "update",
      preferredColumn: null,
      value,
    }
  }

  if (key.upArrow || key.downArrow) {
    const { column, lineIndex } = getCursorLineColumn(value, cursorOffset)
    const targetLineIndex = key.upArrow ? lineIndex - 1 : lineIndex + 1
    if (targetLineIndex < 0 || targetLineIndex >= getPromptLines(value).length) {
      return { kind: "noop" }
    }
    const preferredColumn = options.preferredColumn ?? column
    return {
      cursorOffset: getCursorOffsetForLineColumn(value, targetLineIndex, preferredColumn),
      kind: "update",
      preferredColumn,
      value,
    }
  }

  if (key.backspace || key.delete) {
    const deleteRange = getPromptTextInputDeleteRange({
      cursorOffset,
      value,
    })

    if (deleteRange === undefined) {
      return { kind: "noop" }
    }

    return {
      cursorOffset: deleteRange.start,
      kind: "update",
      preferredColumn: null,
      value: value.slice(0, deleteRange.start) + value.slice(deleteRange.end),
    }
  }

  const inserted = key.return && key.shift ? "\n" : normalizePromptInputChunk(input)
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

export function applyPromptTextInputSegmentsKey(options: {
  cursorOffset: number
  input: string
  key: PromptTextInputKey
  nextPasteId: number
  preferredColumn?: number | null
  segments: PromptTextInputSegment[]
  treatAsPaste?: boolean
}): PromptTextInputSegmentsAction {
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

  const segments = normalizePromptTextInputSegments(options.segments)
  const value = getPromptTextInputDisplayValue(segments)
  const cursorOffset = snapPromptTextInputCursorOffset(segments, options.cursorOffset, "nearest")
  const metaShortcut = key.meta ? input.toLowerCase() : input

  if (key.meta && metaShortcut === "b") {
    return {
      cursorOffset: snapPromptTextInputCursorOffset(segments, findWordBoundaryLeft(value, cursorOffset), "left"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (key.meta && metaShortcut === "f") {
    return {
      cursorOffset: snapPromptTextInputCursorOffset(segments, findWordBoundaryRight(value, cursorOffset), "right"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (matchesCtrlCharacterShortcut(input, key, "a") || key.home) {
    return {
      cursorOffset: getCurrentLineBounds(value, cursorOffset).start,
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (matchesCtrlCharacterShortcut(input, key, "e") || key.end) {
    return {
      cursorOffset: getCurrentLineBounds(value, cursorOffset).end,
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (isDeleteWordLeftShortcut(input, key)) {
    const next = deletePromptTextInputDisplayRange({
      cursorOffset,
      end: cursorOffset,
      segments,
      start: findWordBoundaryLeft(value, cursorOffset),
    })
    if (
      getPromptTextInputDisplayValue(next.segments) === value &&
      getPromptTextInputExpandedValue(next.segments) === getPromptTextInputExpandedValue(segments)
    ) {
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
    const nextCursorOffset = key.meta
      ? findWordBoundaryLeft(value, cursorOffset)
      : getPromptTextInputPreviousCursorOffset(value, cursorOffset)
    return {
      cursorOffset: snapPromptTextInputCursorOffset(segments, nextCursorOffset, "left"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (key.rightArrow) {
    const nextCursorOffset = key.meta
      ? findWordBoundaryRight(value, cursorOffset)
      : getPromptTextInputNextCursorOffset(value, cursorOffset)
    return {
      cursorOffset: snapPromptTextInputCursorOffset(segments, nextCursorOffset, "right"),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments,
    }
  }

  if (key.upArrow || key.downArrow) {
    const { column, lineIndex } = getCursorLineColumn(value, cursorOffset)
    const targetLineIndex = key.upArrow ? lineIndex - 1 : lineIndex + 1
    if (targetLineIndex < 0 || targetLineIndex >= getPromptLines(value).length) {
      return { kind: "noop" }
    }
    const preferredColumn = options.preferredColumn ?? column
    return {
      cursorOffset: snapPromptTextInputCursorOffset(
        segments,
        getCursorOffsetForLineColumn(value, targetLineIndex, preferredColumn),
        "nearest",
      ),
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn,
      segments,
    }
  }

  if (key.backspace || key.delete) {
    const deleteRange = getPromptTextInputDeleteRange({
      cursorOffset,
      value,
    })

    if (deleteRange === undefined) {
      return { kind: "noop" }
    }

    const next = deletePromptTextInputDisplayRange({
      cursorOffset: deleteRange.start,
      end: deleteRange.end,
      segments,
      start: deleteRange.start,
    })
    return {
      cursorOffset: next.cursorOffset,
      kind: "update",
      nextPasteId: options.nextPasteId,
      preferredColumn: null,
      segments: next.segments,
    }
  }

  const inserted = key.return && key.shift ? "\n" : normalizePromptInputChunk(input)
  if (inserted.length === 0) {
    return { kind: "noop" }
  }

  const isPaste = options.treatAsPaste === true && !key.return && inserted.includes("\n")
  const insertedSegments = isPaste
    ? [{ kind: "paste", pasteId: options.nextPasteId, text: inserted } satisfies PromptTextInputSegment]
    : [{ kind: "text", text: inserted } satisfies PromptTextInputSegment]
  const next = insertPromptTextInputSegmentsAtDisplayOffset({
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

export type { PromptTextInputAction, PromptTextInputSegmentsAction }
