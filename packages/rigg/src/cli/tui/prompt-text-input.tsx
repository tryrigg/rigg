import { Text, useInput, useStdout } from "ink"
import { useEffect, useRef, useState } from "react"

import { renderPromptTextValue, snapPromptTextInputCursorOffset } from "./prompt-text-cursor"
import { applyPromptTextInputSegmentsKey, type PromptTextInputKey } from "./prompt-text-edit"
import {
  acquirePromptTextInputBracketedPaste,
  createPromptTextInputSegments,
  detectPromptPasteControl,
  getPromptTextInputDisplayLength,
  getPromptTextInputDisplayValue,
  getPromptTextInputExpandedValue,
  normalizePromptInputChunk,
  reconcilePromptTextInputControlledState,
  releasePromptTextInputBracketedPaste,
  type PromptTextInputSegment,
} from "./prompt-text-paste"

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
    nextState.cursorOffset = snapPromptTextInputCursorOffset(nextState.segments, nextState.cursorOffset, "nearest")

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
          key: key as PromptTextInputKey,
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
