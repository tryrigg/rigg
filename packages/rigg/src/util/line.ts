import { normalizeError } from "./error"

export type LineSource = {
  done: Promise<Error | undefined>
  onLine: (listener: (line: string) => void) => void
}

export function readLines(stream: ReadableStream<Uint8Array>): LineSource {
  const decoder = new TextDecoder()
  const listeners = new Set<(line: string) => void>()

  const emit = (line: string) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line
    for (const listener of listeners) {
      listener(text)
    }
  }

  const flush = (input: string, end = false) => {
    let start = 0

    for (let i = 0; i < input.length; i += 1) {
      const ch = input[i]
      if (ch === "\n") {
        emit(input.slice(start, i))
        start = i + 1
        continue
      }
      if (ch !== "\r") {
        continue
      }
      if (i + 1 === input.length && !end) {
        return input.slice(start)
      }

      emit(input.slice(start, i))
      start = i + (input[i + 1] === "\n" ? 2 : 1)
      if (start > i + 1) {
        i += 1
      }
    }

    return input.slice(start)
  }

  const done = (async () => {
    const reader = stream.getReader()
    let pending = ""

    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) {
          break
        }

        pending = flush(pending + decoder.decode(chunk.value, { stream: true }))
      }

      const trailing = flush(pending + decoder.decode(), true)
      if (trailing !== "") {
        emit(trailing)
      }
      return undefined
    } catch (error) {
      return new Error("failed to read process output", {
        cause: normalizeError(error),
      })
    } finally {
      reader.releaseLock()
    }
  })()

  return {
    done,
    onLine: (listener) => {
      listeners.add(listener)
    },
  }
}
