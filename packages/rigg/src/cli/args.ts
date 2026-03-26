import type { RunStatus } from "../session/schema"

export const RUN_OUTPUT_FORMATS = ["text", "json", "stream-json"] as const
const RUN_OUTPUT_FORMAT_SET = new Set<string>(RUN_OUTPUT_FORMATS)
const RUN_OUTPUT_FORMAT_LABEL = RUN_OUTPUT_FORMATS.join(", ")
const RUN_OUTPUT_FORMAT_USAGE = RUN_OUTPUT_FORMATS.join("|")

export type RunOutputFormat = (typeof RUN_OUTPUT_FORMATS)[number]
export type RunMode =
  | { kind: "interactive" }
  | { kind: "headless_text"; verbose: boolean }
  | { kind: "headless_json" }
  | { kind: "headless_stream_json" }

const RUN_HELP = `  run <workflow_id> [--input key=value] [--auto-continue] [--headless] [--output-format <${RUN_OUTPUT_FORMAT_USAGE}>] [--verbose]`

export type ParsedCommand =
  | { kind: "invalid"; message: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init" }
  | { kind: "list" }
  | { json: boolean; kind: "validate" }
  | { json: boolean; kind: "show"; runId?: string }
  | { first?: string; json: boolean; kind: "logs"; run?: string; second?: string; step?: string }
  | { json: boolean; kind: "history"; limit: number; offset: number; status?: RunStatus; workflowId?: string }
  | { autoContinue: boolean; inputs: string[]; kind: "run"; mode: RunMode; workflowId?: string }

type InvalidCommand = Extract<ParsedCommand, { kind: "invalid" }>
type RawRunCommand = {
  autoContinue: boolean
  headless: boolean
  inputs: string[]
  outputFormat: RunOutputFormat
  verbose: boolean
  workflowId?: string
}

function invalid(message: string): InvalidCommand {
  return { kind: "invalid", message }
}

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
    case "list":
      return { kind: "list" }
    case "validate":
      return { kind: "validate", json: rest.includes("--json") }
    case "history":
      return parseHistoryCommand(rest)
    case "show":
      return parseShowCommand(rest)
    case "logs":
      return parseLogsCommand(rest)
    case "run":
      return parseRunCommand(rest)
    default:
      return { kind: "help" }
  }
}

function parseIntegerOption(name: string, value: string | undefined): ParsedCommand | number {
  if (value === undefined) {
    return { kind: "invalid", message: `\`${name}\` requires a value.` }
  }

  if (!/^\d+$/.test(value)) {
    return { kind: "invalid", message: `\`${name}\` requires a non-negative integer.` }
  }

  return Number(value)
}

function parseRequiredOption(name: string, label: string, value: string | undefined): ParsedCommand | string {
  if (value === undefined || value.startsWith("--")) {
    return invalid(`\`${name}\` requires a ${label}.`)
  }

  return value
}

function isRunOutputFormat(value: string): value is RunOutputFormat {
  return RUN_OUTPUT_FORMAT_SET.has(value)
}

function parseHistoryCommand(args: string[]): ParsedCommand {
  let workflowId: string | undefined
  let status: RunStatus | undefined
  let limit = 10
  let offset = 0
  let json = false

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === undefined) {
      continue
    }
    if (value === "--json") {
      json = true
      continue
    }
    if (value === "--status") {
      const next = args[index + 1]
      if (next !== "running" && next !== "succeeded" && next !== "failed" && next !== "aborted") {
        return {
          kind: "invalid",
          message: "`rigg history --status` requires one of: running, succeeded, failed, aborted.",
        }
      }
      status = next
      index += 1
      continue
    }
    if (value === "--limit") {
      const parsed = parseIntegerOption("rigg history --limit", args[index + 1])
      if (typeof parsed !== "number") {
        return parsed
      }
      limit = parsed
      index += 1
      continue
    }
    if (value === "--offset") {
      const parsed = parseIntegerOption("rigg history --offset", args[index + 1])
      if (typeof parsed !== "number") {
        return parsed
      }
      offset = parsed
      index += 1
      continue
    }
    if (value.startsWith("--")) {
      return { kind: "invalid", message: `Unknown history option: ${value}` }
    }
    if (workflowId === undefined) {
      workflowId = value
      continue
    }
    return { kind: "invalid", message: `Unexpected history argument: ${value}` }
  }

  return {
    json,
    kind: "history",
    limit,
    offset,
    ...(status === undefined ? {} : { status }),
    ...(workflowId === undefined ? {} : { workflowId }),
  }
}

function parseShowCommand(args: string[]): ParsedCommand {
  let runId: string | undefined
  let json = false

  for (const value of args) {
    if (value === "--json") {
      json = true
      continue
    }
    if (value?.startsWith("--")) {
      return { kind: "invalid", message: `Unknown show option: ${value}` }
    }
    if (runId === undefined && value !== undefined) {
      runId = value
      continue
    }
    if (value !== undefined) {
      return { kind: "invalid", message: `Unexpected show argument: ${value}` }
    }
  }

  return { json, kind: "show", ...(runId === undefined ? {} : { runId }) }
}

function parseLogsCommand(args: string[]): ParsedCommand {
  const positionals: string[] = []
  let json = false
  let run: string | undefined
  let step: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === undefined) {
      continue
    }
    if (value === "--json") {
      json = true
      continue
    }
    if (value === "--run") {
      const parsed = parseRequiredOption("rigg logs --run", "run id", args[index + 1])
      if (typeof parsed !== "string") {
        return parsed
      }
      run = parsed
      index += 1
      continue
    }
    if (value === "--step") {
      const parsed = parseRequiredOption("rigg logs --step", "step id", args[index + 1])
      if (typeof parsed !== "string") {
        return parsed
      }
      step = parsed
      index += 1
      continue
    }
    if (value.startsWith("--")) {
      return { kind: "invalid", message: `Unknown logs option: ${value}` }
    }
    positionals.push(value)
    if (positionals.length > 2) {
      return { kind: "invalid", message: `Unexpected logs argument: ${value}` }
    }
  }

  return {
    json,
    kind: "logs",
    ...(positionals[0] === undefined ? {} : { first: positionals[0] }),
    ...(run === undefined ? {} : { run }),
    ...(positionals[1] === undefined ? {} : { second: positionals[1] }),
    ...(step === undefined ? {} : { step }),
  }
}

function parseRunCommand(args: string[]): ParsedCommand {
  const raw = scanRunCommand(args)
  if ("message" in raw) {
    return raw
  }

  const mode = normalizeRunMode(raw)
  if (mode.kind === "invalid") {
    return mode
  }

  return raw.workflowId === undefined
    ? { autoContinue: raw.autoContinue, inputs: raw.inputs, kind: "run", mode }
    : { autoContinue: raw.autoContinue, inputs: raw.inputs, kind: "run", mode, workflowId: raw.workflowId }
}

function scanRunCommand(args: string[]): RawRunCommand | InvalidCommand {
  let autoContinue = false
  let headless = false
  const inputs: string[] = []
  let outputFormat: RunOutputFormat = "text"
  let verbose = false
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
    if (value === "--headless") {
      headless = true
      continue
    }
    if (value === "--output-format") {
      const next = args[index + 1]
      if (next === undefined || next.startsWith("--")) {
        return invalid(`\`rigg run --output-format\` requires one of: ${RUN_OUTPUT_FORMAT_LABEL}.`)
      }
      if (!isRunOutputFormat(next)) {
        return invalid(`\`rigg run --output-format\` must be one of: ${RUN_OUTPUT_FORMAT_LABEL}.`)
      }
      outputFormat = next
      index += 1
      continue
    }
    if (value === "--verbose") {
      verbose = true
      continue
    }
    if (value.startsWith("--")) {
      return invalid(`Unknown run option: ${value}`)
    }
    if (workflowId === undefined) {
      workflowId = value
      continue
    }
    return invalid(`Unexpected run argument: ${value}`)
  }

  return { autoContinue, headless, inputs, outputFormat, verbose, ...(workflowId === undefined ? {} : { workflowId }) }
}

function normalizeRunMode(raw: RawRunCommand): RunMode | InvalidCommand {
  if (!raw.headless) {
    if (raw.outputFormat !== "text") {
      return invalid("`--output-format` requires `--headless`.")
    }
    if (raw.verbose) {
      return invalid("`--verbose` requires `--headless`.")
    }
    return { kind: "interactive" }
  }

  if (raw.outputFormat === "text") {
    return { kind: "headless_text", verbose: raw.verbose }
  }

  if (raw.verbose) {
    return invalid("`--verbose` is only supported with `--output-format text`.")
  }

  if (raw.outputFormat === "json") {
    return { kind: "headless_json" }
  }

  return { kind: "headless_stream_json" }
}

export function renderHelp(): string[] {
  return [
    "rigg <command>",
    "",
    "Commands:",
    "  init",
    "  list",
    "  upgrade [target]",
    "  validate [--json]",
    "  history [workflow_id] [--status <status>] [--limit <n>] [--offset <n>] [--json]",
    "  show <run_id> [--json]",
    "  logs [run_id] [step] [--run <id>] [--step <name>] [--json]",
    RUN_HELP,
    "",
    "Options:",
    "  -h, --help",
    "  -V, --version",
  ]
}
