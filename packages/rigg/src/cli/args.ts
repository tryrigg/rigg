import { RunStatusSchema, type RunStatus } from "../session/schema"

export const RUN_OUTPUT_FORMATS = ["text", "json", "stream-json"] as const
const RUN_OUTPUT_FORMAT_SET = new Set<string>(RUN_OUTPUT_FORMATS)
const RUN_OUTPUT_FORMAT_LABEL = RUN_OUTPUT_FORMATS.join(", ")
const RUN_OUTPUT_FORMAT_USAGE = RUN_OUTPUT_FORMATS.join("|")
const HISTORY_STATUS_SET = new Set<string>(RunStatusSchema.options)
const HISTORY_STATUS_LABEL = RunStatusSchema.options.join(", ")

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
  | { host: string; json: boolean; kind: "serve"; port: number }
  | { json: boolean; kind: "validate" }
  | { json: boolean; kind: "show"; runId?: string }
  | { first?: string; json: boolean; kind: "logs"; run?: string; second?: string; step?: string }
  | { json: boolean; kind: "history"; limit: number; offset: number; status?: RunStatus; workflowId?: string }
  | { autoContinue: boolean; inputs: string[]; kind: "run"; mode: RunMode; workflowId?: string }

type InvalidCommand = Extract<ParsedCommand, { kind: "invalid" }>
type ArgCursor = {
  args: string[]
  index: number
}
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

function createArgCursor(args: string[]): ArgCursor {
  return { args, index: 0 }
}

function nextArg(cursor: ArgCursor): string | undefined {
  const value = cursor.args[cursor.index]
  cursor.index += 1
  return value
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
    case "serve":
      return parseServeCommand(rest)
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

function parseIntegerOption(name: string, value: string | undefined): InvalidCommand | number {
  if (value === undefined) {
    return invalid(`\`${name}\` requires a value.`)
  }

  if (!/^\d+$/.test(value)) {
    return invalid(`\`${name}\` requires a non-negative integer.`)
  }

  return Number(value)
}

function parseRequiredOption(name: string, label: string, value: string | undefined): InvalidCommand | string {
  if (value === undefined || value.startsWith("--")) {
    return invalid(`\`${name}\` requires a ${label}.`)
  }

  return value
}

function isRunOutputFormat(value: string): value is RunOutputFormat {
  return RUN_OUTPUT_FORMAT_SET.has(value)
}

function isHistoryStatus(value: string): value is RunStatus {
  return HISTORY_STATUS_SET.has(value)
}

function takeIntegerOption(cursor: ArgCursor, name: string): InvalidCommand | number {
  return parseIntegerOption(name, nextArg(cursor))
}

function takeRequiredOption(cursor: ArgCursor, name: string, label: string): InvalidCommand | string {
  return parseRequiredOption(name, label, nextArg(cursor))
}

function parseServeCommand(args: string[]): ParsedCommand {
  const cursor = createArgCursor(args)
  let host = "127.0.0.1"
  let json = false
  let port = 3000

  for (let value = nextArg(cursor); value !== undefined; value = nextArg(cursor)) {
    if (value === "--json") {
      json = true
      continue
    }
    if (value === "--host") {
      const parsed = takeRequiredOption(cursor, "rigg serve --host", "host")
      if (typeof parsed !== "string") {
        return parsed
      }
      host = parsed
      continue
    }
    if (value === "--port") {
      const parsed = takeIntegerOption(cursor, "rigg serve --port")
      if (typeof parsed !== "number") {
        return parsed
      }
      port = parsed
      continue
    }
    if (value.startsWith("--")) {
      return invalid(`Unknown serve option: ${value}`)
    }
    return invalid(`Unexpected serve argument: ${value}`)
  }

  return { host, json, kind: "serve", port }
}

function parseHistoryCommand(args: string[]): ParsedCommand {
  const cursor = createArgCursor(args)
  let workflowId: string | undefined
  let status: RunStatus | undefined
  let limit = 10
  let offset = 0
  let json = false

  for (let value = nextArg(cursor); value !== undefined; value = nextArg(cursor)) {
    if (value === "--json") {
      json = true
      continue
    }
    if (value === "--status") {
      const next = nextArg(cursor)
      if (next === undefined || !isHistoryStatus(next)) {
        return invalid(`\`rigg history --status\` requires one of: ${HISTORY_STATUS_LABEL}.`)
      }
      status = next
      continue
    }
    if (value === "--limit") {
      const parsed = takeIntegerOption(cursor, "rigg history --limit")
      if (typeof parsed !== "number") {
        return parsed
      }
      limit = parsed
      continue
    }
    if (value === "--offset") {
      const parsed = takeIntegerOption(cursor, "rigg history --offset")
      if (typeof parsed !== "number") {
        return parsed
      }
      offset = parsed
      continue
    }
    if (value.startsWith("--")) {
      return invalid(`Unknown history option: ${value}`)
    }
    if (workflowId === undefined) {
      workflowId = value
      continue
    }
    return invalid(`Unexpected history argument: ${value}`)
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
  const cursor = createArgCursor(args)
  let runId: string | undefined
  let json = false

  for (let value = nextArg(cursor); value !== undefined; value = nextArg(cursor)) {
    if (value === "--json") {
      json = true
      continue
    }
    if (value.startsWith("--")) {
      return invalid(`Unknown show option: ${value}`)
    }
    if (runId === undefined) {
      runId = value
      continue
    }
    return invalid(`Unexpected show argument: ${value}`)
  }

  return { json, kind: "show", ...(runId === undefined ? {} : { runId }) }
}

function parseLogsCommand(args: string[]): ParsedCommand {
  const cursor = createArgCursor(args)
  const positionals: string[] = []
  let json = false
  let run: string | undefined
  let step: string | undefined

  for (let value = nextArg(cursor); value !== undefined; value = nextArg(cursor)) {
    if (value === "--json") {
      json = true
      continue
    }
    if (value === "--run") {
      const parsed = takeRequiredOption(cursor, "rigg logs --run", "run id")
      if (typeof parsed !== "string") {
        return parsed
      }
      run = parsed
      continue
    }
    if (value === "--step") {
      const parsed = takeRequiredOption(cursor, "rigg logs --step", "step id")
      if (typeof parsed !== "string") {
        return parsed
      }
      step = parsed
      continue
    }
    if (value.startsWith("--")) {
      return invalid(`Unknown logs option: ${value}`)
    }
    positionals.push(value)
    if (positionals.length > 2) {
      return invalid(`Unexpected logs argument: ${value}`)
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
  const cursor = createArgCursor(args)
  let autoContinue = false
  let headless = false
  const inputs: string[] = []
  let outputFormat: RunOutputFormat = "text"
  let verbose = false
  let workflowId: string | undefined

  for (let value = nextArg(cursor); value !== undefined; value = nextArg(cursor)) {
    if (value === "--input") {
      const input = nextArg(cursor)
      if (input === undefined) {
        return invalid("`rigg run --input` requires a following KEY=VALUE argument.")
      }
      inputs.push(input)
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
      const next = nextArg(cursor)
      if (next === undefined || next.startsWith("--")) {
        return invalid(`\`rigg run --output-format\` requires one of: ${RUN_OUTPUT_FORMAT_LABEL}.`)
      }
      if (!isRunOutputFormat(next)) {
        return invalid(`\`rigg run --output-format\` must be one of: ${RUN_OUTPUT_FORMAT_LABEL}.`)
      }
      outputFormat = next
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
    "  serve [--host <host>] [--port <n>] [--json]",
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
