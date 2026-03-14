import { describe, expect, test } from "bun:test"
import { join } from "node:path"

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
    expect(result.stdout).toBe("rigg 0.0.0\n")
  })

  test("help output lists version as an option, not a command", async () => {
    const result = await runCli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Commands:\n  init")
    expect(result.stdout).toContain("Options:\n  -h, --help\n  -V, --version\n")
    expect(result.stdout).not.toContain("Commands:\n  version\n")
  })

  test("version subcommand no longer prints the version", async () => {
    const result = await runCli(["version"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("rigg <command>\n")
    expect(result.stdout).not.toContain("rigg 0.0.0\n")
  })
})
