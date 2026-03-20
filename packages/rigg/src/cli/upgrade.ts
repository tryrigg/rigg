import { chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { RIGG_VERSION } from "../version"
import { normalizeError } from "../util/error"

const DEFAULT_INSTALL_URL = "https://tryrigg.com/install"

type UpgradeResult = {
  exitCode: number
  stderrLines: string[]
  stdoutLines: string[]
}

export type ParsedArgs = {
  target: string | undefined
}

export type Runtime = {
  currentVersion?: string
  env?: NodeJS.ProcessEnv
  execPath?: string
  fetchScript?: (url: string) => Promise<string>
  installUrl?: string
  runScript?: (script: string, env: NodeJS.ProcessEnv) => Promise<void>
  writeStdoutLine?: (line: string) => void
}

function success(stdoutLines: string[] = [], stderrLines: string[] = []): UpgradeResult {
  return {
    exitCode: 0,
    stderrLines,
    stdoutLines,
  }
}

function failure(stderrLines: string[] = [], exitCode = 1, stdoutLines: string[] = []): UpgradeResult {
  return {
    exitCode,
    stderrLines,
    stdoutLines,
  }
}

export function normalizeTarget(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed
}

export function parseArgs(args: string[]): ParsedArgs {
  let target: string | undefined

  for (const value of args) {
    if (value.startsWith("--")) {
      throw new Error(`Unknown upgrade option: ${value}`)
    }
    if (target !== undefined) {
      throw new Error("`rigg upgrade` accepts at most one version target.")
    }
    target = value
  }

  return {
    target: normalizeTarget(target),
  }
}

function executableName(execPath: string): string {
  return basename(execPath).toLowerCase()
}

export function isDevBuild(currentVersion: string): boolean {
  if (currentVersion === "dev") {
    return true
  }

  const prerelease = currentVersion.split("+", 1)[0]?.split("-", 2)[1]
  if (!prerelease) {
    return false
  }

  return prerelease.split(".").includes("dev")
}

export function isBunExec(execPath: string): boolean {
  const executable = executableName(execPath)
  return executable === "bun" || executable === "bunx"
}

export function inferInstallDir(currentVersion: string, execPath: string): string | null {
  if (isDevBuild(currentVersion) || isBunExec(execPath)) {
    return null
  }
  if (executableName(execPath) !== "rigg") {
    return null
  }
  return dirname(execPath)
}

export function createInstallerEnv(input: {
  currentVersion: string
  env: NodeJS.ProcessEnv
  execPath: string
  target?: string | undefined
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.env }
  delete env["RIGG_VERSION"]
  delete env["RIGG_INSTALL_DIR"]

  if (input.target !== undefined) {
    env["RIGG_VERSION"] = input.target
  }

  const inferredInstallDir = inferInstallDir(input.currentVersion, input.execPath)
  if (inferredInstallDir !== null) {
    env["RIGG_INSTALL_DIR"] = inferredInstallDir
  }

  return env
}

export async function fetchScript(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download installer from ${url} (HTTP ${response.status})`)
  }
  return response.text()
}

export async function runScript(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  const scriptPath = join(
    tmpdir(),
    `rigg-install-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sh`,
  )
  await Bun.write(scriptPath, script)
  chmodSync(scriptPath, 0o700)

  try {
    const installer = Bun.spawn(["bash", scriptPath], {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await installer.exited
    if (exitCode !== 0) {
      throw new Error(`Installer failed with exit code ${exitCode}`)
    }
  } finally {
    rmSync(scriptPath, { force: true })
  }
}

export async function runCommand(args: ParsedArgs, runtime: Runtime = {}): Promise<UpgradeResult> {
  const currentVersion = runtime.currentVersion ?? RIGG_VERSION
  const execPath = runtime.execPath ?? process.execPath
  const target = normalizeTarget(args.target)

  if (isDevBuild(currentVersion) || isBunExec(execPath)) {
    return failure([
      "`rigg upgrade` is only available from an installed release binary. Re-run using the installed `rigg` command instead of `bun run`.",
    ])
  }

  if (target !== undefined && normalizeTarget(currentVersion) === target) {
    return success([`rigg upgrade skipped: v${target} is already installed.`])
  }

  const fetcher = runtime.fetchScript ?? fetchScript
  const installer = runtime.runScript ?? runScript
  const installUrl = runtime.installUrl ?? DEFAULT_INSTALL_URL
  const writeStdoutLine = runtime.writeStdoutLine ?? ((line: string) => console.log(line))
  const env = createInstallerEnv({
    currentVersion,
    env: runtime.env ?? process.env,
    execPath,
    target,
  })

  try {
    writeStdoutLine(target === undefined ? "Upgrading rigg to latest..." : `Upgrading rigg to v${target}...`)
    const script = await fetcher(installUrl)
    await installer(script, env)
    writeStdoutLine("Upgrade complete.")
    return success()
  } catch (error) {
    return failure([normalizeError(error).message])
  }
}
