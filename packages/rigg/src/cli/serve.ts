import { createApp, createState, closeState } from "../server/routes"
import { normalizeError } from "../util/error"
import { compactJson } from "../util/json"

type Command = {
  host: string
  json: boolean
  kind: "serve"
  port: number
}

type Dependencies = {
  createAppImpl: typeof createApp
  createStateImpl: typeof createState
  onStderrLine: (line: string) => void
  onStdoutLine: (line: string) => void
  serveImpl: typeof Bun.serve
  waitForStopImpl: (stop: () => Promise<void>) => Promise<void>
}

const defaultDeps: Dependencies = {
  createAppImpl: createApp,
  createStateImpl: createState,
  onStderrLine: (line) => {
    process.stderr.write(`${line}\n`)
  },
  onStdoutLine: (line) => {
    process.stdout.write(`${line}\n`)
  },
  serveImpl: Bun.serve,
  waitForStopImpl: waitForStop,
}

function renderStartup(command: Command, port: number): string {
  const url = `http://${command.host}:${port}`
  if (command.json) {
    return compactJson({
      host: command.host,
      port,
      url,
    })
  }

  return `Listening on ${url}`
}

async function waitForStop(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
      resolve()
    }

    const onSignal = () => {
      void stop().finally(finish)
    }

    process.on("SIGINT", onSignal)
    process.on("SIGTERM", onSignal)
  })
}

export async function runCommand(
  _cwd: string,
  command: Command,
  overrides: Partial<Dependencies> = {},
): Promise<number> {
  const deps = { ...defaultDeps, ...overrides }
  const state = deps.createStateImpl()

  try {
    const app = deps.createAppImpl(state)
    const server = deps.serveImpl({
      fetch: app.fetch,
      hostname: command.host,
      port: command.port,
    })

    const stop = async () => {
      server.stop(true)
      await closeState(state)
    }

    deps.onStdoutLine(renderStartup(command, server.port ?? command.port))
    await deps.waitForStopImpl(stop)
    return 0
  } catch (error) {
    deps.onStderrLine(normalizeError(error).message)
    await closeState(state)
    return 1
  }
}
