import { afterEach, describe, expect, test } from "bun:test"

import { startServer } from "../../../src/provider/codex/proc"
import { stream } from "../../fixture/stream"

const spawn = Bun.spawn

afterEach(() => {
  Bun.spawn = spawn
})

describe("codex/proc", () => {
  test("waits for buffered output when the process exits before readers are ready", async () => {
    Bun.spawn = ((options: { onExit?: (proc: unknown, code: number | null) => void }) => {
      const child = {
        exitCode: 1,
        kill: () => {},
        signalCode: null,
        stderr: stream(["startup failed\n"]),
        stdin: {
          end: async () => {},
          write: () => {},
        },
        stdout: stream(['{"jsonrpc":"2.0","id":"req_1","result":{"ok":true}}\n']),
      }

      options.onExit?.(child as never, 1)
      return child as never
    }) as unknown as typeof Bun.spawn

    const proc = startServer({
      binaryPath: "codex",
      cwd: process.cwd(),
      env: process.env,
    })
    const stdout: string[] = []
    const stderr: string[] = []

    proc.stdout.onLine((line) => {
      stdout.push(line)
    })
    proc.stderr.onLine((line) => {
      stderr.push(line)
    })

    await expect(proc.exited).resolves.toEqual({
      code: 1,
      error: undefined,
      expected: false,
      signal: null,
    })
    expect(stdout).toEqual(['{"jsonrpc":"2.0","id":"req_1","result":{"ok":true}}'])
    expect(stderr).toEqual(["startup failed"])
  })
})
