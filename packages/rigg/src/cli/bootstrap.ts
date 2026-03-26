import { parseCommand, renderHelp } from "./args"
import * as history from "./history"
import * as init from "./init"
import * as list from "./list"
import * as logs from "./logs"
import * as run from "./run"
import * as show from "./show"
import * as upgrade from "./upgrade"
import * as validate from "./validate"
import { assertUnreachable } from "../util/assert"
import { RIGG_VERSION } from "../version"
import { writeLines } from "./out"

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = (() => {
    const [commandName, ...rest] = argv
    if (commandName === "upgrade") {
      try {
        return { kind: "upgrade" as const, ...upgrade.parseArgs(rest) }
      } catch (error) {
        return { kind: "invalid" as const, message: error instanceof Error ? error.message : String(error) }
      }
    }
    return parseCommand(argv)
  })()
  const cwd = process.cwd()

  switch (command.kind) {
    case "invalid":
      writeLines([command.message], process.stderr)
      return 1
    case "help":
      writeLines(renderHelp(), process.stdout)
      return 0
    case "version":
      writeLines([`rigg ${RIGG_VERSION}`], process.stdout)
      return 0
    case "init": {
      const result = await init.runCommand(cwd)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "list": {
      const result = await list.runCommand(cwd)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "upgrade": {
      const result = await upgrade.runCommand(
        { target: command.target },
        { writeStdoutLine: (line) => writeLines([line], process.stdout) },
      )
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "validate": {
      const result = await validate.runCommand(cwd, command.json)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "history": {
      const result = await history.runCommand(cwd, command)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "show": {
      const result = await show.runCommand(cwd, command.runId, command.json)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "logs": {
      const result = await logs.runCommand(cwd, command)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "run": {
      const result = await run.runCommand(cwd, command.workflowId, {
        autoContinue: command.autoContinue,
        inputs: command.inputs,
        mode: command.mode,
      })
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
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
