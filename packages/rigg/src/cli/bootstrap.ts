import { parseCommand, renderHelp } from "./args"
import * as history from "./history"
import * as init from "./init"
import * as list from "./list"
import * as logs from "./logs"
import * as run from "./run"
import * as serve from "./serve"
import * as show from "./show"
import * as upgrade from "./upgrade"
import * as validate from "./validate"
import { assertUnreachable } from "../util/assert"
import { RIGG_VERSION } from "../version"
import { writeLines } from "./out"

type Dependencies = {
  cwd: () => string
  history: typeof history
  init: typeof init
  list: typeof list
  logs: typeof logs
  parseCommand: typeof parseCommand
  run: typeof run
  serve: typeof serve
  show: typeof show
  upgrade: typeof upgrade
  validate: typeof validate
  writeLines: typeof writeLines
}

const defaultDeps: Dependencies = {
  cwd: () => process.cwd(),
  history,
  init,
  list,
  logs,
  parseCommand,
  run,
  serve,
  show,
  upgrade,
  validate,
  writeLines,
}

export async function main(argv: string[] = process.argv.slice(2), deps: Partial<Dependencies> = {}): Promise<number> {
  const resolved = { ...defaultDeps, ...deps }
  const command = (() => {
    const [commandName, ...rest] = argv
    if (commandName === "upgrade") {
      try {
        return { kind: "upgrade" as const, ...resolved.upgrade.parseArgs(rest) }
      } catch (error) {
        return { kind: "invalid" as const, message: error instanceof Error ? error.message : String(error) }
      }
    }
    return resolved.parseCommand(argv)
  })()
  const cwd = resolved.cwd()

  switch (command.kind) {
    case "invalid":
      resolved.writeLines([command.message], process.stderr)
      return 1
    case "help":
      resolved.writeLines(renderHelp(), process.stdout)
      return 0
    case "version":
      resolved.writeLines([`rigg ${RIGG_VERSION}`], process.stdout)
      return 0
    case "init": {
      const result = await resolved.init.runCommand(cwd)
      resolved.writeLines(result.stdoutLines, process.stdout)
      resolved.writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "list": {
      const result = await resolved.list.runCommand(cwd)
      resolved.writeLines(result.stdoutLines, process.stdout)
      resolved.writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "serve":
      return await resolved.serve.runCommand(cwd, command)
    case "upgrade": {
      const result = await resolved.upgrade.runCommand(
        { target: command.target },
        { writeStdoutLine: (line) => resolved.writeLines([line], process.stdout) },
      )
      resolved.writeLines(result.stdoutLines, process.stdout)
      resolved.writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "validate": {
      const result = await resolved.validate.runCommand(cwd, command.json)
      resolved.writeLines(result.stdoutLines, process.stdout)
      resolved.writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "history": {
      const result = await resolved.history.runCommand(cwd, command)
      resolved.writeLines(result.stdoutLines, process.stdout)
      resolved.writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "show": {
      const result = await resolved.show.runCommand(cwd, command.runId, command.json)
      resolved.writeLines(result.stdoutLines, process.stdout)
      resolved.writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "logs": {
      const result = await resolved.logs.runCommand(cwd, command)
      resolved.writeLines(result.stdoutLines, process.stdout)
      resolved.writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "run": {
      const result = await resolved.run.runCommand(cwd, command.workflowId, {
        autoContinue: command.autoContinue,
        inputs: command.inputs,
        mode: command.mode,
      })
      resolved.writeLines(result.stdoutLines, process.stdout)
      resolved.writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    default:
      return assertUnreachable(command)
  }
}

if (import.meta.main) {
  const exitCode = await main()
  process.exit(exitCode)
}
