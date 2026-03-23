import { filterEnv } from "../util/env"
import { isMissingPathError, normalizeError } from "../util/error"
import { spawnSpec } from "../util/spawn"
import { isSupported, parseVersion, upgradeMessage } from "./version"

export type ClaudeProcessOptions = {
  binaryPath?: string | undefined
  cwd: string
  env: Record<string, string | undefined>
}

export function assertVersion(options: ClaudeProcessOptions): string {
  const command = options.binaryPath ?? "claude"
  const result = runVersion(command, options)
  const output = `${result.stdout}\n${result.stderr}`.trim()
  const version = parseVersion(output)

  if (result.error !== undefined) {
    if (isMissingPathError(result.error)) {
      throw new Error(missingBinaryMessage())
    }
    throw new Error(`failed to run ${command} --version`, {
      cause: result.error,
    })
  }
  if (result.status !== 0) {
    if (output.length === 0) {
      throw new Error("Failed to read Claude Code version: no version output was produced.")
    }
    throw new Error(`Failed to read Claude Code version: ${output}`)
  }
  if (version === null) {
    throw new Error(`Failed to read Claude Code version: ${output}`)
  }
  if (!isSupported(version)) {
    throw new Error(upgradeMessage(version))
  }

  return version
}

export function resolveBinaryPath(options: ClaudeProcessOptions): string {
  if (options.binaryPath !== undefined) {
    return options.binaryPath
  }

  const env = filterEnv(options.env)
  const path = Bun.which(
    "claude",
    env["PATH"] === undefined ? { cwd: options.cwd } : { PATH: env["PATH"], cwd: options.cwd },
  )
  if (path !== null) {
    return path
  }

  throw new Error(missingBinaryMessage())
}

function runVersion(
  command: string,
  options: ClaudeProcessOptions,
): {
  error?: Error | undefined
  status: number
  stderr: string
  stdout: string
} {
  const env = filterEnv(options.env)
  const spec = spawnSpec(command, ["--version"], { cwd: options.cwd, env })

  try {
    const result = Bun.spawnSync({
      ...spec,
      cwd: options.cwd,
      env,
      stderr: "pipe",
      stdout: "pipe",
    })
    return {
      status: result.exitCode,
      stderr: result.stderr === undefined ? "" : result.stderr.toString("utf8"),
      stdout: result.stdout === undefined ? "" : result.stdout.toString("utf8"),
    }
  } catch (error) {
    return {
      error: normalizeError(error),
      status: 1,
      stderr: "",
      stdout: "",
    }
  }
}

function missingBinaryMessage(): string {
  return "Claude Code CLI is not installed or not on PATH. Install it with `brew install --cask claude-code`, then verify with `claude --version`."
}
