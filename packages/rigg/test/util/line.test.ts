import { describe, expect, test } from "bun:test"

import { readLines } from "../../src/util/line"
import { stream } from "../fixture/stream"

describe("util/line", () => {
  test("reads newline-delimited output across chunk boundaries", async () => {
    const src = readLines(stream(["foo\r", "\nbar\nbaz"]))
    const lines: string[] = []

    src.onLine((line) => {
      lines.push(line)
    })

    expect(await src.done).toBeUndefined()
    expect(lines).toEqual(["foo", "bar", "baz"])
  })

  test("treats bare carriage returns as line delimiters", async () => {
    const src = readLines(stream(["foo\rbar", "\rbaz\r"]))
    const lines: string[] = []

    src.onLine((line) => {
      lines.push(line)
    })

    expect(await src.done).toBeUndefined()
    expect(lines).toEqual(["foo", "bar", "baz"])
  })

  test("returns an actionable error when the stream fails", async () => {
    const src = readLines(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("boom"))
        },
      }),
    )

    const error = await src.done
    expect(error?.message).toBe("failed to read process output")
    expect(error?.cause).toBeInstanceOf(Error)
  })
})
