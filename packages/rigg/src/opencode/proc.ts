import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { createServer } from "node:net"

import { onAbort } from "../util/abort"
import { filterEnv } from "../util/env"
import { isMissingPathError, normalizeError } from "../util/error"
import { readLines, type LineSource } from "../util/line"
import { createPromiseKit } from "../util/promise"
import { spawnSpec } from "../util/spawn"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 4096
const HEALTH_TIMEOUT_MS = 30_000
const MIN_VERSION = "1.0.0"
const PORT_ATTEMPTS = 3
const SERVER_IDLE_MS = 5_000
const SERVER_TERM_GRACE_MS = 1_000

export type OpencodeProcessOptions = {
  binaryPath?: string | undefined
  cwd: string
  env: Record<string, string | undefined>
}

export type OpencodeProcInternals = {
  createClient?: typeof createOpencodeClient
  healthTimeoutMs?: number | undefined
  isPortAvailable?: typeof isPortAvailable
  pingServer?: typeof pingServer
  startServer?: typeof startServer
}

export type OpencodeServerLease = {
  client: OpencodeClient
  close: () => Promise<void>
  markStale: () => void
  stopNow: () => Promise<void>
  url: string
}

export type OpencodeServerProcess = {
  close: (force?: boolean) => Promise<void>
  exited: Promise<{
    code: number | null
    error?: Error | undefined
    expected: boolean
    signal: NodeJS.Signals | null
  }>
  stderr: LineSource
  stdout: LineSource
  url: Promise<string>
}

type AcquireOptions = OpencodeProcessOptions & {
  internals?: OpencodeProcInternals | undefined
  onDiagnostic?: ((message: string) => Promise<void> | void) | undefined
  scopeId: string
  signal?: AbortSignal | undefined
}

type ServerEntry = {
  client: OpencodeClient
  idleTimer?: ReturnType<typeof setTimeout> | undefined
  key: string
  proc: OpencodeServerProcess
  refs: number
  stale: boolean
  stopPromise?: Promise<void> | undefined
  url: string
}

const servers = new Map<string, ServerEntry>()
let lock = Promise.resolve()
let cleanupRegistered = false

export function assertVersion(options: OpencodeProcessOptions): string {
  const command = options.binaryPath ?? "opencode"
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
    throw new Error(`Failed to read OpenCode CLI version from ${command} --version. Re-run \`${command} --version\`.`)
  }
  if (version === null) {
    throw new Error(`Failed to parse OpenCode CLI version from ${command} --version: ${output}`)
  }
  if (compareVersions(version, MIN_VERSION) < 0) {
    throw new Error(
      `OpenCode CLI ${version} is too old for server mode. Upgrade to ${MIN_VERSION} or newer, then verify with \`${command} --version\`.`,
    )
  }

  return version
}

export async function acquireServer(options: AcquireOptions): Promise<OpencodeServerLease> {
  registerProcessCleanup()

  const key = serverKey(options)
  const internals = options.internals ?? {}

  return await withLock(async () => {
    let entry = servers.get(key)
    if (entry !== undefined) {
      clearIdleTimer(entry)
      entry.refs += 1
      if (entry.stale || !(await (internals.pingServer ?? pingServer)(entry.client))) {
        await stopEntry(entry, true)
        entry = undefined
      }
    }

    if (entry === undefined) {
      entry = await createEntry(options, internals)
      servers.set(key, entry)
    }

    return {
      client: entry.client,
      close: async () => releaseEntry(entry),
      markStale: () => {
        entry.stale = true
      },
      stopNow: async () => {
        entry.stale = true
        await stopEntry(entry, true)
      },
      url: entry.url,
    }
  })
}

export function resolveBinaryPath(options: OpencodeProcessOptions): string {
  if (options.binaryPath !== undefined) {
    return options.binaryPath
  }

  const env = filterEnv(options.env)
  const path = Bun.which(
    "opencode",
    env["PATH"] === undefined ? { cwd: options.cwd } : { PATH: env["PATH"], cwd: options.cwd },
  )
  if (path !== null) {
    return path
  }

  throw new Error(missingBinaryMessage())
}

export async function pingServer(client: OpencodeClient): Promise<boolean> {
  try {
    const result = await client.global.health({ signal: AbortSignal.timeout(1_000) })
    return result.error === undefined && result.data?.healthy === true
  } catch {
    return false
  }
}

export function parseVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/)
  return match?.[1] ?? null
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part))
  const b = right.split(".").map((part) => Number(part))
  const length = Math.max(a.length, b.length)

  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) {
      return diff < 0 ? -1 : 1
    }
  }

  return 0
}

export function startServer(
  options: OpencodeProcessOptions & { port: number; signal?: AbortSignal | undefined },
): OpencodeServerProcess {
  const env = serverEnv(options.env)
  const spec = spawnSpec(
    resolveBinaryPath(options),
    [`serve`, `--hostname=${DEFAULT_HOST}`, `--port=${options.port}`],
    {
      cwd: options.cwd,
      env,
    },
  )
  const stdoutReady = createPromiseKit<LineSource>()
  const stderrReady = createPromiseKit<LineSource>()
  const exit = createPromiseKit<{
    code: number | null
    error?: Error | undefined
    expected: boolean
    signal: NodeJS.Signals | null
  }>()
  const url = createPromiseKit<string>()
  let output = ""
  let closePromise: Promise<void> | undefined
  let closing = false
  let ready = false

  const child = Bun.spawn({
    ...spec,
    cwd: options.cwd,
    env,
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
    onExit: (proc, code) => {
      void Promise.all([stdoutReady.promise, stderrReady.promise])
        .then(([stdout, stderr]) => Promise.all([stdout.done, stderr.done]))
        .then(([stdoutError, stderrError]) => {
          if (!ready) {
            url.reject(
              new Error(
                `Failed to start OpenCode server on port ${options.port}. ${formatOutputMessage(output, "Run `opencode serve` manually to inspect startup output.")}`,
              ),
            )
          }
          exit.resolve({
            code,
            error: stdoutError ?? stderrError,
            expected: closing,
            signal: proc.signalCode,
          })
        })
        .catch((error) => {
          if (!ready) {
            url.reject(
              new Error(
                `Failed to start OpenCode server on port ${options.port}. ${formatOutputMessage(output, "Run `opencode serve` manually to inspect startup output.")}`,
              ),
            )
          }
          exit.resolve({
            code,
            error: normalizeError(error),
            expected: closing,
            signal: proc.signalCode,
          })
        })
    },
  })

  const stdout = readLines(child.stdout)
  const stderr = readLines(child.stderr)
  stdoutReady.resolve(stdout)
  stderrReady.resolve(stderr)

  stdout.onLine((line) => {
    output += `${line}\n`
    const urlValue = parseServerUrl(line)
    if (urlValue === null) {
      return
    }
    ready = true
    url.resolve(urlValue)
  })
  stderr.onLine((line) => {
    output += `${line}\n`
  })

  const disposeAbort = onAbort(options.signal, () => {
    url.reject(new Error("OpenCode server startup aborted."))
  })

  return {
    close: async (force = false) => {
      if (closePromise !== undefined) {
        await closePromise
        return
      }

      closing = true
      closePromise = (async () => {
        if (child.exitCode !== null) {
          await exit.promise
          disposeAbort()
          return
        }

        child.kill("SIGTERM")
        let timer: ReturnType<typeof setTimeout> | undefined

        if (force) {
          timer = setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL")
            }
          }, SERVER_TERM_GRACE_MS)
          timer.unref?.()
        }

        try {
          await exit.promise
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer)
          }
          disposeAbort()
        }
      })()

      await closePromise
    },
    exited: exit.promise,
    stderr,
    stdout,
    url: url.promise,
  }
}

function clearIdleTimer(entry: ServerEntry): void {
  if (entry.idleTimer === undefined) {
    return
  }
  clearTimeout(entry.idleTimer)
  entry.idleTimer = undefined
}

async function createEntry(options: AcquireOptions, internals: OpencodeProcInternals): Promise<ServerEntry> {
  assertVersion(options)
  const start = internals.startServer ?? startServer
  const createClient = internals.createClient ?? createOpencodeClient
  const checkPortAvailability = internals.isPortAvailable ?? isPortAvailable
  let lastError: Error | undefined
  let lastErrorWasPortConflict = false
  const ports: number[] = []

  await options.onDiagnostic?.("Starting opencode server...")

  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = DEFAULT_PORT + attempt
    ports.push(port)
    const proc = start({
      binaryPath: options.binaryPath,
      cwd: options.cwd,
      env: options.env,
      port,
      signal: options.signal,
    })

    try {
      const url = await proc.url
      const client = createClient(createClientOptions({ baseUrl: url, cwd: options.cwd, env: options.env }))

      await options.onDiagnostic?.("Waiting for health check...")
      if (
        !(await waitForHealthy(
          client,
          internals.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
          internals.pingServer ?? pingServer,
        ))
      ) {
        await proc.close(true)
        throw new Error(
          `Timed out waiting for OpenCode server health check at ${url}. Verify the server with \`opencode serve --hostname=${DEFAULT_HOST} --port=${port}\`.`,
        )
      }

      return {
        client,
        key: serverKey(options),
        proc,
        refs: 1,
        stale: false,
        url,
      }
    } catch (error) {
      lastError = normalizeError(error)
      await proc.close(true)
      lastErrorWasPortConflict = await isPortConflict(lastError, DEFAULT_HOST, port, checkPortAvailability)
      if (!lastErrorWasPortConflict || attempt + 1 >= PORT_ATTEMPTS) {
        break
      }
    }
  }

  if (lastError !== undefined && lastErrorWasPortConflict) {
    throw new Error(
      `Failed to start OpenCode server because ports ${ports.join(", ")} are already in use. Free one of those ports or re-run after stopping the conflicting process.`,
    )
  }

  throw lastError ?? new Error("Failed to start OpenCode server.")
}

function formatOutputMessage(output: string, fallback: string): string {
  const text = output.trim()
  if (text.length === 0) {
    return fallback
  }
  return `Server output: ${text}`
}

async function isPortConflict(
  error: Error,
  host: string,
  port: number,
  checkPortAvailability: typeof isPortAvailable,
): Promise<boolean> {
  if (isPortInUseError(error)) {
    return true
  }

  return !(await checkPortAvailability(host, port))
}

function isPortInUseError(error: Error): boolean {
  const message = error.message.toLowerCase()
  return (
    message.includes("eaddrinuse") || message.includes("address already in use") || message.includes("already in use")
  )
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer()
    let settled = false

    const finish = (result: boolean) => {
      if (settled) {
        return
      }
      settled = true
      resolve(result)
    }

    server.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code !== "EADDRINUSE")
    })
    server.listen({ exclusive: true, host, port }, () => {
      server.close(() => finish(true))
    })
    server.unref()
  })
}

function missingBinaryMessage(): string {
  return "OpenCode CLI is not installed or not on PATH. Install it, then verify with `opencode --version`."
}

function parseServerUrl(line: string): string | null {
  if (!line.startsWith("opencode server listening")) {
    return null
  }

  const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
  return match?.[1] ?? null
}

function serverEnv(env: Record<string, string | undefined>): Record<string, string> {
  return filterEnv({
    ...env,
    OPENCODE_CONFIG_CONTENT: env["OPENCODE_CONFIG_CONTENT"] ?? JSON.stringify({}),
  })
}

function serverKey(options: Pick<AcquireOptions, "binaryPath" | "cwd" | "env" | "scopeId">): string {
  return JSON.stringify({
    binaryPath: options.binaryPath ?? null,
    cwd: options.cwd,
    env: Object.fromEntries(Object.entries(serverEnv(options.env)).sort(([a], [b]) => a.localeCompare(b))),
    scopeId: options.scopeId,
  })
}

function createClientOptions(options: {
  baseUrl: string
  cwd: string
  env: Record<string, string | undefined>
}): Parameters<typeof createOpencodeClient>[0] {
  const headers = serverAuthHeaders(options.env)
  return {
    baseUrl: options.baseUrl,
    directory: options.cwd,
    ...(headers === undefined ? {} : { headers }),
    throwOnError: true,
  }
}

function serverAuthHeaders(env: Record<string, string | undefined>): Record<string, string> | undefined {
  const password = env["OPENCODE_SERVER_PASSWORD"]
  if (password === undefined || password.length === 0) {
    return undefined
  }

  const username = env["OPENCODE_SERVER_USERNAME"] || "opencode"
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  }
}

function registerProcessCleanup(): void {
  if (cleanupRegistered) {
    return
  }
  cleanupRegistered = true

  const cleanup = () => {
    void stopAllServers(true)
  }
  process.once("beforeExit", cleanup)
  process.once("exit", cleanup)
}

async function stopAllServers(force: boolean): Promise<void> {
  await Promise.all([...servers.values()].map((entry) => stopEntry(entry, force)))
}

async function releaseEntry(entry: ServerEntry): Promise<void> {
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs > 0) {
    return
  }

  clearIdleTimer(entry)
  entry.idleTimer = setTimeout(() => {
    void stopEntry(entry, false)
  }, SERVER_IDLE_MS)
  entry.idleTimer.unref?.()
}

function runVersion(
  command: string,
  options: OpencodeProcessOptions,
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

async function stopEntry(entry: ServerEntry, force: boolean): Promise<void> {
  if (entry.stopPromise !== undefined) {
    await entry.stopPromise
    return
  }

  clearIdleTimer(entry)
  servers.delete(entry.key)
  entry.stopPromise = entry.proc.close(force)
  try {
    await entry.stopPromise
  } finally {
    entry.stopPromise = undefined
  }
}

async function waitForHealthy(client: OpencodeClient, timeoutMs: number, check: typeof pingServer): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await check(client)) {
      return true
    }
    await Bun.sleep(100)
  }

  return false
}

async function withLock<T>(action: () => Promise<T>): Promise<T> {
  const previous = lock
  const next = createPromiseKit<void>()
  lock = previous.then(() => next.promise)
  await previous

  try {
    return await action()
  } finally {
    next.resolve()
  }
}
