import { runInitCommand, runRunCommand, runValidateCommand } from "./commands"
import { assertUnreachable } from "../util/assert"
import { RIGG_VERSION } from "../version"
import { writeLines } from "./output"

type ParsedCommand =
  | { kind: "invalid"; message: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init" }
  | { json: boolean; kind: "validate" }
  | { inputs: string[]; kind: "run"; workflowId?: string }

function parseCommand(argv: string[]): ParsedCommand {
  const [commandName, ...rest] = argv

  switch (commandName) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" }
    case "--version":
    case "-V":
      return { kind: "version" }
    case "init":
      return { kind: "init" }
    case "validate":
      return { kind: "validate", json: rest.includes("--json") }
    case "run":
      return parseRunCommand(rest)
    default:
      return { kind: "help" }
  }
}

function parseRunCommand(args: string[]): ParsedCommand {
  const inputs: string[] = []
  let workflowId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === undefined) {
      continue
    }
    if (value === "--input") {
      const input = args[index + 1]
      if (input === undefined) {
        return { kind: "invalid", message: "`rigg run --input` requires a following KEY=VALUE argument." }
      }
      inputs.push(input)
      index += 1
      continue
    }
    if (value.startsWith("--")) {
      return { kind: "invalid", message: `Unknown run option: ${value}` }
    }
    if (workflowId === undefined) {
      workflowId = value
    }
  }

  return workflowId === undefined ? { inputs, kind: "run" } : { inputs, kind: "run", workflowId }
}

function renderHelp(): string[] {
  return [
    "rigg <command>",
    "",
    "Commands:",
    "  init",
    "  validate [--json]",
    "  run <workflow_id> [--input key=value]",
    "",
    "Options:",
    "  -h, --help",
    "  -V, --version",
  ]
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = parseCommand(argv)
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
    case "validate": {
      const result = await runValidateCommand(cwd, command.json)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "run": {
      const result = await runRunCommand(cwd, command.workflowId, {
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
