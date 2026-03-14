import { runInitCommand, runLogsCommand, runRunCommand, runStatusCommand, runValidateCommand } from "./commands"
import { assertUnreachable } from "../util/assert"
import { RIGG_VERSION } from "../version"
import { writeLines } from "./output"

type ParsedCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init" }
  | { json: boolean; kind: "validate" }
  | { inputs: string[]; json: boolean; kind: "run"; quiet: boolean; workflowId?: string }
  | { json: boolean; kind: "status"; runId?: string }
  | { kind: "logs"; node?: string; runId?: string; stderr: boolean }

function parseCommand(argv: string[]): ParsedCommand {
  const [commandName, ...rest] = argv

  switch (commandName) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" }
    case "version":
    case "--version":
    case "-V":
      return { kind: "version" }
    case "init":
      return { kind: "init" }
    case "validate":
      return { kind: "validate", json: rest.includes("--json") }
    case "run":
      return parseRunCommand(rest)
    case "status":
      return parseStatusCommand(rest)
    case "logs":
      return parseLogsCommand(rest)
    default:
      return { kind: "help" }
  }
}

function parseRunCommand(args: string[]): ParsedCommand {
  const inputs: string[] = []
  let json = false
  let quiet = false
  let workflowId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === "--json") {
      json = true
      continue
    }
    if (value === "--quiet") {
      quiet = true
      continue
    }
    if (value === "--input") {
      const input = args[index + 1]
      if (input !== undefined) {
        inputs.push(input)
        index += 1
      }
      continue
    }
    if (workflowId === undefined) {
      workflowId = value
    }
  }

  return workflowId === undefined
    ? { inputs, json, kind: "run", quiet }
    : { inputs, json, kind: "run", quiet, workflowId }
}

function parseStatusCommand(args: string[]): ParsedCommand {
  let json = false
  let runId: string | undefined

  for (const value of args) {
    if (value === "--json") {
      json = true
    } else if (runId === undefined) {
      runId = value
    }
  }

  return runId === undefined ? { json, kind: "status" } : { json, kind: "status", runId }
}

function parseLogsCommand(args: string[]): ParsedCommand {
  let node: string | undefined
  let runId: string | undefined
  let stderr = false

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === "--stderr") {
      stderr = true
      continue
    }
    if (value === "--node") {
      node = args[index + 1]
      index += 1
      continue
    }
    if (runId === undefined) {
      runId = value
    }
  }

  return {
    kind: "logs",
    ...(node === undefined ? {} : { node }),
    ...(runId === undefined ? {} : { runId }),
    stderr,
  }
}

function renderHelp(): string[] {
  return [
    "rigg <command>",
    "",
    "Commands:",
    "  version",
    "  init",
    "  validate [--json]",
    "  run <workflow_id> [--json] [--quiet] [--input key=value]",
    "  status [run_id] [--json]",
    "  logs <run_id> [--node id] [--stderr]",
  ]
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = parseCommand(argv)
  const cwd = process.cwd()

  switch (command.kind) {
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
        json: command.json,
        quiet: command.quiet,
      })
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "status": {
      const result = await runStatusCommand(cwd, command.runId, command.json)
      writeLines(result.stdoutLines, process.stdout)
      writeLines(result.stderrLines, process.stderr)
      return result.exitCode
    }
    case "logs": {
      const result = await runLogsCommand(
        cwd,
        command.runId,
        command.node === undefined ? { stderr: command.stderr } : { node: command.node, stderr: command.stderr },
      )
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
