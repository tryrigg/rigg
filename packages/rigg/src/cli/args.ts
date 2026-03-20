export type ParsedCommand =
  | { kind: "invalid"; message: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init" }
  | { json: boolean; kind: "validate" }
  | { autoContinue: boolean; inputs: string[]; kind: "run"; workflowId?: string }

export function parseCommand(argv: string[]): ParsedCommand {
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
  let autoContinue = false
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
    if (value === "--auto-continue") {
      autoContinue = true
      continue
    }
    if (value.startsWith("--")) {
      return { kind: "invalid", message: `Unknown run option: ${value}` }
    }
    if (workflowId === undefined) {
      workflowId = value
    }
  }

  return workflowId === undefined
    ? { autoContinue, inputs, kind: "run" }
    : { autoContinue, inputs, kind: "run", workflowId }
}

export function renderHelp(): string[] {
  return [
    "rigg <command>",
    "",
    "Commands:",
    "  init",
    "  upgrade [target]",
    "  validate [--json]",
    "  run <workflow_id> [--input key=value] [--auto-continue]",
    "",
    "Options:",
    "  -h, --help",
    "  -V, --version",
  ]
}
