import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  acquireServer,
  assertVersion,
  compareVersions,
  parseVersion,
  startServer,
  type OpencodeServerProcess,
} from "../../../src/provider/opencode/proc"
import { installFakeOpenCode } from "../../fixture/fake-opencode"
import { stream } from "../../fixture/stream"

function ok<T>(data: T) {
  return {
    data,
    error: undefined,
    request: new Request("http://localhost"),
    response: new Response(),
  } as const
}

function processResult(url: Promise<string>): OpencodeServerProcess {
  return {
    close: async () => {},
    exited: Promise.resolve({
      code: 0,
      error: undefined,
      expected: true,
      signal: null,
    }),
    stderr: {
      done: Promise.resolve(undefined),
      onLine: () => {},
    },
    stdout: {
      done: Promise.resolve(undefined),
      onLine: () => {},
    },
    url,
  }
}

describe("opencode/proc", () => {
  test("parses and compares versions", () => {
    expect(parseVersion("opencode 1.3.3")).toBe("1.3.3")
    expect(parseVersion("version: 0.9.0\n")).toBe("0.9.0")
    expect(compareVersions("1.3.3", "1.3.2")).toBe(1)
    expect(compareVersions("1.3.3", "1.3.3")).toBe(0)
    expect(compareVersions("1.2.9", "1.3.0")).toBe(-1)
  })

  test("rejects CLI versions older than the server minimum", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-opencode-proc-version-"))

    try {
      const binDir = await installFakeOpenCode(cwd, { versionOutput: "opencode 0.9.0" })

      expect(() =>
        assertVersion({
          binaryPath: join(binDir, "opencode"),
          cwd,
          env: process.env,
        }),
      ).toThrow("too old for server mode")
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("retries port conflicts and reuses a shared server lease", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-opencode-proc-reuse-"))

    try {
      const binDir = await installFakeOpenCode(cwd)
      const urls = [Promise.reject(new Error("address already in use")), Promise.resolve("http://127.0.0.1:4097")]
      const started: number[] = []

      const first = await acquireServer({
        binaryPath: join(binDir, "opencode"),
        cwd,
        env: process.env,
        internals: {
          createClient: (() => ({})) as never,
          pingServer: async () => true,
          startServer: (options) => {
            started.push(options.port)
            const url = urls.shift()
            if (url === undefined) {
              throw new Error("unexpected startServer call")
            }
            return processResult(url)
          },
        },
        scopeId: "run-1",
      })
      await first.close()

      const second = await acquireServer({
        binaryPath: join(binDir, "opencode"),
        cwd,
        env: process.env,
        internals: {
          createClient: (() => ({})) as never,
          pingServer: async () => true,
          startServer: () => {
            throw new Error("shared server should have been reused")
          },
        },
        scopeId: "run-1",
      })

      expect(started).toEqual([4096, 4097])
      expect(first.url).toBe("http://127.0.0.1:4097")
      expect(second.url).toBe("http://127.0.0.1:4097")

      await second.close()
      await second.stopNow()
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("retries when OpenCode hides a port conflict behind a generic startup error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-opencode-proc-generic-port-conflict-"))

    try {
      const binDir = await installFakeOpenCode(cwd)
      const started: number[] = []
      const urls = [
        Promise.reject(new Error("Failed to start server on port 4096")),
        Promise.resolve("http://127.0.0.1:4097"),
      ]

      const lease = await acquireServer({
        binaryPath: join(binDir, "opencode"),
        cwd,
        env: process.env,
        internals: {
          createClient: (() => ({})) as never,
          isPortAvailable: async (_host, port) => port !== 4096,
          pingServer: async () => true,
          startServer: (options) => {
            started.push(options.port)
            const url = urls.shift()
            if (url === undefined) {
              throw new Error("unexpected startServer call")
            }
            return processResult(url)
          },
        },
        scopeId: "run-generic-port-conflict",
      })

      expect(started).toEqual([4096, 4097])
      expect(lease.url).toBe("http://127.0.0.1:4097")

      await lease.stopNow()
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("starts a new shared server when step env changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-opencode-proc-env-"))

    try {
      const binDir = await installFakeOpenCode(cwd)
      const started: string[] = []
      const urls = [Promise.resolve("http://127.0.0.1:4096"), Promise.resolve("http://127.0.0.1:4097")]

      const first = await acquireServer({
        binaryPath: join(binDir, "opencode"),
        cwd,
        env: { ...process.env, OPENAI_API_KEY: "first" },
        internals: {
          createClient: (() => ({})) as never,
          pingServer: async () => true,
          startServer: (options) => {
            started.push(options.env["OPENAI_API_KEY"] ?? "")
            const url = urls.shift()
            if (url === undefined) {
              throw new Error("unexpected startServer call")
            }
            return processResult(url)
          },
        },
        scopeId: "run-1",
      })

      const second = await acquireServer({
        binaryPath: join(binDir, "opencode"),
        cwd,
        env: { ...process.env, OPENAI_API_KEY: "second" },
        internals: {
          createClient: (() => ({})) as never,
          pingServer: async () => true,
          startServer: (options) => {
            started.push(options.env["OPENAI_API_KEY"] ?? "")
            const url = urls.shift()
            if (url === undefined) {
              throw new Error("unexpected startServer call")
            }
            return processResult(url)
          },
        },
        scopeId: "run-1",
      })

      expect(started).toEqual(["first", "second"])
      expect(first.url).toBe("http://127.0.0.1:4096")
      expect(second.url).toBe("http://127.0.0.1:4097")

      await first.stopNow()
      await second.stopNow()
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("turns health timeouts into actionable startup errors", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-opencode-proc-health-"))

    try {
      const binDir = await installFakeOpenCode(cwd)

      await expect(
        acquireServer({
          binaryPath: join(binDir, "opencode"),
          cwd,
          env: process.env,
          internals: {
            createClient: (() => ({})) as never,
            healthTimeoutMs: 0,
            pingServer: async () => false,
            startServer: () => processResult(Promise.resolve("http://127.0.0.1:4096")),
          },
          scopeId: "run-2",
        }),
      ).rejects.toThrow("Timed out waiting for OpenCode server health check")
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("accepts the standard SDK response envelope during health checks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-opencode-proc-envelope-"))

    try {
      const binDir = await installFakeOpenCode(cwd)
      let config: Record<string, unknown> | undefined

      const lease = await acquireServer({
        binaryPath: join(binDir, "opencode"),
        cwd,
        env: process.env,
        internals: {
          createClient: ((input: Record<string, unknown>) => {
            config = input
            return {
              global: {
                health: async () => ok({ healthy: true, version: "1.3.3" }),
              },
            }
          }) as never,
          startServer: () => processResult(Promise.resolve("http://127.0.0.1:4096")),
        },
        scopeId: "run-envelope",
      })

      expect(config).toMatchObject({
        baseUrl: "http://127.0.0.1:4096",
        directory: cwd,
        throwOnError: true,
      })
      expect(config?.["responseStyle"]).toBeUndefined()

      await lease.close()
      await lease.stopNow()
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("adds basic auth headers when the OpenCode server is password protected", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "rigg-opencode-proc-auth-"))

    try {
      const binDir = await installFakeOpenCode(cwd)
      let config: Record<string, unknown> | undefined

      const lease = await acquireServer({
        binaryPath: join(binDir, "opencode"),
        cwd,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: "secret-password",
          OPENCODE_SERVER_USERNAME: "rigg",
        },
        internals: {
          createClient: ((input: Record<string, unknown>) => {
            config = input
            return {}
          }) as never,
          pingServer: async () => true,
          startServer: () => processResult(Promise.resolve("http://127.0.0.1:4096")),
        },
        scopeId: "run-auth",
      })

      expect(config).toMatchObject({
        headers: {
          Authorization: `Basic ${Buffer.from("rigg:secret-password").toString("base64")}`,
        },
      })

      await lease.close()
      await lease.stopNow()
    } finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  test("preserves caller supplied OPENCODE_CONFIG_CONTENT", async () => {
    const spawn = Bun.spawn
    let env: Record<string, string> | undefined

    try {
      Bun.spawn = ((options: {
        env: Record<string, string>
        onExit?: (proc: unknown, code: number | null) => void
      }) => {
        env = options.env
        const child = {
          exitCode: 0,
          kill: () => {},
          signalCode: null,
          stderr: stream([]),
          stdout: stream(["opencode server listening on http://127.0.0.1:4096\n"]),
        }
        options.onExit?.(child as never, 0)
        return child as never
      }) as unknown as typeof Bun.spawn

      const proc = startServer({
        binaryPath: "/tmp/opencode",
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { review: {} } }),
        },
        port: 4096,
      })

      await expect(proc.url).resolves.toBe("http://127.0.0.1:4096")
      await proc.close()
      expect(env?.["OPENCODE_CONFIG_CONTENT"]).toBe(JSON.stringify({ agent: { review: {} } }))
    } finally {
      Bun.spawn = spawn
    }
  })
})
