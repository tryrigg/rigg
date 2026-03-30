import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { main } from "../../src/cli/bootstrap"

const packageRoot = join(import.meta.dir, "..", "..")

async function runCli(args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", "./src/cli/bootstrap.ts", ...args], {
    cwd: packageRoot,
    stderr: "pipe",
    stdout: "pipe",
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { exitCode, stderr, stdout }
}

describe("cli/bootstrap", () => {
  test("--version prints the CLI version", async () => {
    const result = await runCli(["--version"])

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toBe("rigg dev\n")
  })

  test("help output lists version as an option, not a command", async () => {
    const result = await runCli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Commands:\n  init")
    expect(result.stdout).toContain("  list\n")
    expect(result.stdout).toContain("  serve [--host <host>] [--port <n>] [--json]\n")
    expect(result.stdout).toContain("  upgrade [target]\n")
    expect(result.stdout).toContain(
      "  history [workflow_id] [--status <status>] [--limit <n>] [--offset <n>] [--json]\n",
    )
    expect(result.stdout).toContain("Options:\n  -h, --help\n  -V, --version\n")
    expect(result.stdout).not.toContain("Commands:\n  version\n")
  })

  test("run help includes auto-continue", async () => {
    const result = await runCli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      "run <workflow_id> [--input key=value] [--auto-continue] [--headless] [--output-format <text|json|stream-json>] [--verbose]",
    )
  })

  test("version subcommand no longer prints the version", async () => {
    const result = await runCli(["version"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("rigg <command>\n")
    expect(result.stdout).not.toContain("rigg dev\n")
  })

  test("upgrade subcommand is recognized and rejected in dev mode", async () => {
    const result = await runCli(["upgrade", "v0.1.2"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("`rigg upgrade` is only available from an installed release binary.")
    expect(result.stdout).toBe("")
  })

  test("dispatches serve through the serve command module", async () => {
    const calls: Array<{ cwd: string; command: unknown }> = []
    const exitCode = await main(["serve", "--port", "4000"], {
      cwd: () => "/tmp/example",
      serve: {
        runCommand: async (cwd: string, command: { host: string; json: boolean; kind: "serve"; port: number }) => {
          calls.push({ command, cwd })
          return 0
        },
      } as never,
    })

    expect(exitCode).toBe(0)
    expect(calls).toEqual([
      {
        command: {
          host: "127.0.0.1",
          json: false,
          kind: "serve",
          port: 4000,
        },
        cwd: "/tmp/example",
      },
    ])
  })
})
