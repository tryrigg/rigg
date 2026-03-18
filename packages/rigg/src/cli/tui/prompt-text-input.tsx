import { Text, useInput, useStdout, type Key } from "ink"
import { useEffect, useRef, useState, type ReactNode } from "react"

const BRACKETED_PASTE_DISABLE = "\u001b[?2004l"
const BRACKETED_PASTE_END = "\u001b[201~"
const BRACKETED_PASTE_END_STRIPPED = "[201~"
const BRACKETED_PASTE_ENABLE = "\u001b[?2004h"
const BRACKETED_PASTE_START = "\u001b[200~"
const BRACKETED_PASTE_START_STRIPPED = "[200~"
const promptTextInputGraphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined
let bracketedPasteModeUsers = 0

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

export type PromptTextInputSegment = { kind: "paste"; pasteId: number; text: string } | { kind: "text"; text: string }

export type PromptTextInputSegmentsAction =
  | { kind: "noop" }
  | { kind: "submit" }
  | {
      cursorOffset: number
      kind: "update"
      nextPasteId: number
      preferredColumn: number | null
      segments: PromptTextInputSegment[]
    }

function clampCursorOffset(value: string, cursorOffset: number): number {
  return Math.max(0, Math.min(cursorOffset, value.length))
}

function getPromptTextInputCharacterBoundaries(value: string): number[] {
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

function getPromptTextInputBoundaryIndex(boundaries: number[], cursorOffset: number): number {
  const boundaryIndex = boundaries.indexOf(cursorOffset)
  return boundaryIndex === -1 ? 0 : boundaryIndex
}

function getPromptTextInputCharacterCount(value: string): number {
  return Math.max(0, getPromptTextInputCharacterBoundaries(value).length - 1)
}

function getPromptTextInputOffsetForCharacterIndex(value: string, characterIndex: number): number {
  const boundaries = getPromptTextInputCharacterBoundaries(value)
  return boundaries[Math.max(0, Math.min(characterIndex, boundaries.length - 1))] ?? value.length
}

function snapPromptTextInputStringCursorOffset(
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

function getPromptTextInputPreviousCursorOffset(value: string, cursorOffset: number): number {
  const safeCursorOffset = clampCursorOffset(value, cursorOffset)
  const boundaries = getPromptTextInputCharacterBoundaries(value)

  for (let index = boundaries.length - 1; index >= 0; index--) {
    const boundary = boundaries[index]
    if (boundary !== undefined && boundary < safeCursorOffset) {
      return boundary
    }
  }

  return 0
}

function getPromptTextInputNextCursorOffset(value: string, cursorOffset: number): number {
  const safeCursorOffset = clampCursorOffset(value, cursorOffset)

  for (const boundary of getPromptTextInputCharacterBoundaries(value)) {
    if (boundary > safeCursorOffset) {
      return boundary
    }
  }

  return value.length
}

function getPromptTextInputCharacterByBoundaryIndex(
  value: string,
  boundaries: number[],
  boundaryIndex: number,
): string {
  const start = boundaries[boundaryIndex] ?? value.length
  const end = boundaries[boundaryIndex + 1] ?? start
  return value.slice(start, end)
}

function getPromptTextInputCharacterAt(value: string, cursorOffset: number): string | undefined {
  const safeCursorOffset = snapPromptTextInputStringCursorOffset(value, cursorOffset, "nearest")
  const boundaries = getPromptTextInputCharacterBoundaries(value)
  const boundaryIndex = getPromptTextInputBoundaryIndex(boundaries, safeCursorOffset)

  if (boundaryIndex >= boundaries.length - 1) {
    return undefined
  }

  return getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex)
}

type PromptLine = {
  length: number
  start: number
}

function getPromptLines(value: string): PromptLine[] {
  const lines = value.split("\n")
  let start = 0
  return lines.map((line) => {
    const promptLine = { length: line.length, start }
    start += line.length + 1
    return promptLine
  })
}

function getCursorLineColumn(value: string, cursorOffset: number): { column: number; lineIndex: number } {
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

function getCursorOffsetForLineColumn(value: string, lineIndex: number, column: number): number {
  const lines = getPromptLines(value)
  const line = lines[lineIndex]
  if (line === undefined) {
    return clampCursorOffset(value, value.length)
  }
  const lineValue = value.slice(line.start, line.start + line.length)
  return clampCursorOffset(value, line.start + getPromptTextInputOffsetForCharacterIndex(lineValue, column))
}

function getCurrentLineBounds(value: string, cursorOffset: number): { end: number; start: number } {
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

function findWordBoundaryLeft(value: string, cursorOffset: number): number {
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
    boundaryIndex--
  }
  if (boundaryIndex === 0) {
    return 0
  }

  const kind = classifyPromptCharacter(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex - 1))
  while (
    boundaryIndex > 0 &&
    classifyPromptCharacter(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex - 1)) === kind
  ) {
    boundaryIndex--
  }

  return boundaries[boundaryIndex] ?? 0
}

function findWordBoundaryRight(value: string, cursorOffset: number): number {
  const boundaries = getPromptTextInputCharacterBoundaries(value)
  let boundaryIndex = getPromptTextInputBoundaryIndex(
    boundaries,
    snapPromptTextInputStringCursorOffset(value, cursorOffset, "nearest"),
  )

  while (
    boundaryIndex < boundaries.length - 1 &&
    /\s/.test(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex))
  ) {
    boundaryIndex++
  }

  if (boundaryIndex >= boundaries.length - 1) {
    return value.length
  }

  const kind = classifyPromptCharacter(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex))
  while (
    boundaryIndex < boundaries.length - 1 &&
    classifyPromptCharacter(getPromptTextInputCharacterByBoundaryIndex(value, boundaries, boundaryIndex)) === kind
  ) {
    boundaryIndex++
  }

  return boundaries[boundaryIndex] ?? value.length
}

function deleteWordLeft(value: string, cursorOffset: number): { cursorOffset: number; value: string } {
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

function matchesCtrlCharacterShortcut(input: string, key: PromptTextInputKey, shortcut: string): boolean {
  return key.ctrl && input.toLowerCase() === shortcut
}

function isDeleteWordLeftShortcut(input: string, key: PromptTextInputKey): boolean {
  return ((key.backspace || key.delete) && key.meta) || matchesCtrlCharacterShortcut(input, key, "w")
}

function getPromptTextInputPasteLabel(segment: Extract<PromptTextInputSegment, { kind: "paste" }>): string {
  const additionalLines = segment.text.split("\n").length - 1
  return `[Pasted text #${segment.pasteId} +${additionalLines} lines]`
}

function getPromptTextInputSegmentDisplayValue(segment: PromptTextInputSegment): string {
  return segment.kind === "paste" ? getPromptTextInputPasteLabel(segment) : segment.text
}

function normalizePromptTextInputSegments(segments: PromptTextInputSegment[]): PromptTextInputSegment[] {
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

function getPromptTextInputDisplayLength(segments: PromptTextInputSegment[]): number {
  return getPromptTextInputDisplayValue(segments).length
}

function getPromptTextInputDeleteRange(options: {
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

function snapPromptTextInputCursorOffset(
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
      cursorOffset: snapPromptTextInputCursorOffset(reconciledSegments, options.cursorOffset, "nearest"),
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
  bracketedPasteModeUsers++
}

export function releasePromptTextInputBracketedPaste(options: {
  isTTY?: boolean
  write: (data: string) => void
}): void {
  if (!options.isTTY || bracketedPasteModeUsers === 0) {
    return
  }
  bracketedPasteModeUsers--
  if (bracketedPasteModeUsers === 0) {
    options.write(BRACKETED_PASTE_DISABLE)
  }
}

export function normalizePromptInputChunk(input: string): string {
  return input.replaceAll(BRACKETED_PASTE_START, "").replaceAll(BRACKETED_PASTE_END, "").replace(/\r\n?/g, "\n")
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

  // Ink overloads `key.delete` for both ASCII DEL (`\x7f`, the usual Delete
  // key on many macOS terminals) and CSI `\x1b[3~` forward-delete, so we keep
  // backward-delete semantics here for the common DEL case.
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

  // Ink overloads `key.delete` for both ASCII DEL (`\x7f`, the usual Delete
  // key on many macOS terminals) and CSI `\x1b[3~` forward-delete, so we keep
  // backward-delete semantics here for the common DEL case.
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

function renderPromptTextValue(value: string, cursorOffset: number): ReactNode {
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

export function PromptTextInput({
  focus = true,
  onChange,
  onSubmit,
  value,
}: {
  focus?: boolean
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  value: string
}) {
  const { stdout, write } = useStdout()
  const normalizedValue = normalizePromptInputChunk(value)
  const [segments, setSegments] = useState<PromptTextInputSegment[]>(() =>
    createPromptTextInputSegments(normalizedValue),
  )
  const [cursorOffset, setCursorOffset] = useState(() => getPromptTextInputDisplayLength(segments))
  const cursorOffsetRef = useRef(cursorOffset)
  const bracketedPasteBufferRef = useRef("")
  const isBracketedPasteRef = useRef(false)
  const nextPasteIdRef = useRef(1)
  const preferredColumnRef = useRef<number | null>(null)
  const segmentsRef = useRef(segments)

  useEffect(() => {
    const nextState = reconcilePromptTextInputControlledState({
      cursorOffset: cursorOffsetRef.current,
      segments: segmentsRef.current,
      value: normalizedValue,
    })

    if (nextState.segments === segmentsRef.current) {
      return
    }

    segmentsRef.current = nextState.segments
    setSegments(nextState.segments)
    nextPasteIdRef.current = 1
    preferredColumnRef.current = null
    cursorOffsetRef.current = nextState.cursorOffset
    setCursorOffset(nextState.cursorOffset)
  }, [normalizedValue])

  useEffect(() => {
    if (!focus) {
      return
    }

    acquirePromptTextInputBracketedPaste({ isTTY: stdout.isTTY, write })
    return () => {
      releasePromptTextInputBracketedPaste({ isTTY: stdout.isTTY, write })
    }
  }, [focus, stdout.isTTY, write])

  useInput(
    (input, key) => {
      const applyInput = (inputChunk: string, treatAsPaste: boolean) => {
        const action = applyPromptTextInputSegmentsKey({
          cursorOffset: cursorOffsetRef.current,
          input: inputChunk,
          key,
          nextPasteId: nextPasteIdRef.current,
          preferredColumn: preferredColumnRef.current,
          segments: segmentsRef.current,
          treatAsPaste,
        })

        if (action.kind === "noop") {
          return
        }

        if (action.kind === "submit") {
          onSubmit(getPromptTextInputExpandedValue(segmentsRef.current))
          return
        }

        const nextExpandedValue = getPromptTextInputExpandedValue(action.segments)
        segmentsRef.current = action.segments
        cursorOffsetRef.current = action.cursorOffset
        nextPasteIdRef.current = action.nextPasteId
        preferredColumnRef.current = action.preferredColumn
        setSegments(action.segments)
        setCursorOffset(action.cursorOffset)
        if (nextExpandedValue !== normalizedValue) {
          onChange(nextExpandedValue)
        }
      }

      const pasteControl = detectPromptPasteControl(input)
      if (pasteControl === "start") {
        isBracketedPasteRef.current = true
        bracketedPasteBufferRef.current = ""
        return
      }
      if (pasteControl === "end") {
        if (!isBracketedPasteRef.current) {
          return
        }
        isBracketedPasteRef.current = false
        const pasted = bracketedPasteBufferRef.current
        bracketedPasteBufferRef.current = ""
        if (pasted.length > 0) {
          applyInput(pasted, true)
        }
        return
      }
      if (isBracketedPasteRef.current) {
        bracketedPasteBufferRef.current += input
        return
      }
      applyInput(input, input.length > 1)
    },
    { isActive: focus },
  )

  return <Text>{renderPromptTextValue(getPromptTextInputDisplayValue(segments), cursorOffset)}</Text>
}
