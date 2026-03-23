import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

export async function installFakeClaude(
  root: string,
  options: { versionOutput?: string | undefined } = {},
): Promise<string> {
  const binDir = join(root, "bin")
  await mkdir(binDir, { recursive: true })

  const runnerPath = join(binDir, "fake-claude.mjs")
  await writeFile(
    runnerPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(options.versionOutput ?? "claude 2.1.81")} + "\\n")
  process.exit(0)
}
process.stderr.write("unsupported fake claude invocation\\n")
process.exit(1)
`,
    "utf8",
  )

  const wrapperPath = join(binDir, "claude")
  await writeFile(
    wrapperPath,
    [`#!/bin/sh`, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)} "$@"`].join("\n"),
    "utf8",
  )
  await chmod(wrapperPath, 0o755)
  return binDir
}

export function createFakeClaudeSdk(options: {
  messages?: SDKMessage[] | undefined
  onInterrupt?: (() => Promise<void> | void) | undefined
  onQuery?: ((queryOptions: Options | undefined) => Promise<SDKMessage[]> | SDKMessage[]) | undefined
}): {
  sdk: { query: (input: { options?: Options | undefined; prompt: string | AsyncIterable<unknown> }) => Query }
  state: { interrupts: number; queries: Array<Options | undefined> }
} {
  const state = {
    interrupts: 0,
    queries: [] as Array<Options | undefined>,
  }

  return {
    sdk: {
      query: (input) => {
        state.queries.push(input.options)
        return createQuery(
          async () => {
            if (options.onQuery !== undefined) {
              return await options.onQuery(input.options)
            }
            return options.messages ?? []
          },
          async () => {
            state.interrupts += 1
            await options.onInterrupt?.()
          },
        )
      },
    },
    state,
  }
}

function createQuery(getMessages: () => Promise<SDKMessage[]>, onInterrupt: () => Promise<void>): Query {
  let closed = false
  let loaded: SDKMessage[] | null = null
  let index = 0

  const iterator: Query = {
    async next() {
      if (closed) {
        return { done: true, value: undefined }
      }
      if (loaded === null) {
        loaded = await getMessages()
      }
      const value = loaded[index]
      if (value === undefined) {
        return { done: true, value: undefined }
      }
      index += 1
      return { done: false, value }
    },
    async return() {
      closed = true
      return { done: true, value: undefined }
    },
    async throw(error) {
      closed = true
      throw error
    },
    [Symbol.asyncIterator]() {
      return this
    },
    async [Symbol.asyncDispose]() {
      closed = true
    },
    async interrupt() {
      await onInterrupt()
    },
    async rewindFiles() {
      return { canRewind: false }
    },
    async setPermissionMode() {},
    async setModel() {},
    async setMaxThinkingTokens() {},
    async applyFlagSettings() {},
    async initializationResult() {
      return {
        account: {},
        agents: [],
        available_output_styles: [],
        commands: [],
        models: [],
        output_style: "default",
      }
    },
    async supportedCommands() {
      return []
    },
    async supportedModels() {
      return []
    },
    async supportedAgents() {
      return []
    },
    async mcpServerStatus() {
      return []
    },
    async accountInfo() {
      return {}
    },
    async reconnectMcpServer() {},
    async toggleMcpServer() {},
    async setMcpServers() {
      return { added: [], errors: {}, removed: [] }
    },
    async streamInput() {},
    async stopTask() {},
    close() {
      closed = true
    },
  }

  return iterator
}
