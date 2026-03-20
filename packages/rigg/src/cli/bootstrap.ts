import { parseCommand, renderHelp } from "./args"
import { runInitCommand } from "./init"
import { runRunCommand } from "./run"
import { parseUpgradeArgs, runUpgradeCommand } from "./upgrade"
import { runValidateCommand } from "./validate"
import { assertUnreachable } from "../util/assert"
import { RIGG_VERSION } from "../version"
import { writeLines } from "./out"

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = (() => {
    const [commandName, ...rest] = argv
    if (commandName === "upgrade") {
      try {
        return { kind: "upgrade" as const, ...parseUpgradeArgs(rest) }
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
      const result = await runInitCommand(cwd)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "upgrade": {
      const result = await runUpgradeCommand(
        { target: command.target },
        { writeStdoutLine: (line) => writeLines([line], process.stdout) },
      )
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "validate": {
      const result = await runValidateCommand(cwd, command.json)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "run": {
      const result = await runRunCommand(cwd, command.workflowId, {
        autoContinue: command.autoContinue,
        inputs: command.inputs,
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
