import { describe, expect, test } from "bun:test"

import { createInstallerEnv, inferInstallDir, isDevBuild, parseArgs, runCommand } from "../../src/cli/upgrade"

describe("cli/upgrade", () => {
  test("parseArgs parses an optional positional target", () => {
    expect(parseArgs([])).toEqual({ target: undefined })
    expect(parseArgs(["1.2.3"])).toEqual({ target: "1.2.3" })
    expect(parseArgs(["v1.2.3"])).toEqual({ target: "1.2.3" })
  })

  test("parseArgs rejects unknown options", () => {
    expect(() => parseArgs(["--version", "1.2.3"])).toThrow("Unknown upgrade option: --version")
  })

  test("parseArgs rejects multiple positionals", () => {
    expect(() => parseArgs(["1.2.3", "2.0.0"])).toThrow("`rigg upgrade` accepts at most one version target.")
  })

  test("isDevBuild detects local dev build versions", () => {
    expect(isDevBuild("dev")).toBe(true)
    expect(isDevBuild("1.2.3-dev.4+abc123")).toBe(true)
    expect(isDevBuild("0.0.0-dev+abc123.dirty")).toBe(true)
    expect(isDevBuild("1.2.3")).toBe(false)
  })

  test("inferInstallDir skips dev builds", () => {
    expect(inferInstallDir("dev", "/Users/me/.local/bin/rigg")).toBeNull()
    expect(inferInstallDir("1.2.3-dev.4+abc123", "/Users/me/.local/bin/rigg")).toBeNull()
  })

  test("inferInstallDir skips bun executables", () => {
    expect(inferInstallDir("1.0.0", "/opt/homebrew/bin/bun")).toBeNull()
  })

  test("inferInstallDir skips non-rigg executables", () => {
    expect(inferInstallDir("1.0.0", "/usr/local/bin/node")).toBeNull()
  })

  test("inferInstallDir returns installed rigg binary directory for release builds", () => {
    expect(inferInstallDir("1.0.0", "/Users/me/.local/bin/rigg")).toBe("/Users/me/.local/bin")
  })

  test("createInstallerEnv sets requested version and inferred install dir", () => {
    const env = createInstallerEnv({
      currentVersion: "1.0.0",
      env: { PATH: "/usr/bin" },
      execPath: "/Users/me/.local/bin/rigg",
      target: "2.0.0",
    })

    expect(env["RIGG_VERSION"]).toBe("2.0.0")
    expect(env["RIGG_INSTALL_DIR"]).toBe("/Users/me/.local/bin")
  })

  test("createInstallerEnv clears inherited version when upgrading to latest", () => {
    const env = createInstallerEnv({
      currentVersion: "1.0.0",
      env: { PATH: "/usr/bin", RIGG_VERSION: "9.9.9" },
      execPath: "/Users/me/.local/bin/rigg",
    })

    expect(env["RIGG_VERSION"]).toBeUndefined()
    expect(env["RIGG_INSTALL_DIR"]).toBe("/Users/me/.local/bin")
  })

  test("createInstallerEnv ignores inherited install dir for self-upgrades", () => {
    const env = createInstallerEnv({
      currentVersion: "1.0.0",
      env: { PATH: "/usr/bin", RIGG_INSTALL_DIR: "/custom/bin" },
      execPath: "/Users/me/.local/bin/rigg",
    })

    expect(env["RIGG_INSTALL_DIR"]).toBe("/Users/me/.local/bin")
  })

  test("runCommand skips when the requested version is already installed", async () => {
    const result = await runCommand({ target: "v1.2.3" }, { currentVersion: "1.2.3", execPath: "/tmp/rigg" })

    expect(result.exitCode).toBe(0)
    expect(result.stdoutLines).toEqual(["rigg upgrade skipped: v1.2.3 is already installed."])
    expect(result.stderrLines).toEqual([])
  })

  test("runCommand fails fast for dev builds", async () => {
    const result = await runCommand({ target: undefined }, { currentVersion: "dev", execPath: "/tmp/rigg" })

    expect(result.exitCode).toBe(1)
    expect(result.stderrLines).toEqual([
      "`rigg upgrade` is only available from an installed release binary. Re-run using the installed `rigg` command instead of `bun run`.",
    ])
  })

  test("runCommand fails fast for local compiled dev builds", async () => {
    const result = await runCommand(
      { target: undefined },
      { currentVersion: "1.2.3-dev.4+abc123", execPath: "/tmp/rigg" },
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderrLines).toEqual([
      "`rigg upgrade` is only available from an installed release binary. Re-run using the installed `rigg` command instead of `bun run`.",
    ])
  })

  test("runCommand fails fast for bun executables", async () => {
    const result = await runCommand({ target: undefined }, { currentVersion: "1.0.0", execPath: "/tmp/bun" })

    expect(result.exitCode).toBe(1)
    expect(result.stderrLines).toEqual([
      "`rigg upgrade` is only available from an installed release binary. Re-run using the installed `rigg` command instead of `bun run`.",
    ])
  })

  test("runCommand fetches the installer and executes it with prepared env", async () => {
    let fetchedUrl = ""
    let scriptValue = ""
    const logs: string[] = []
    const capture: { env?: NodeJS.ProcessEnv } = {}

    const result = await runCommand(
      { target: "v3.0.0" },
      {
        currentVersion: "1.0.0",
        env: { PATH: "/usr/bin", RIGG_INSTALL_REPO: "tryrigg/rigg" },
        execPath: "/Users/me/.local/bin/rigg",
        fetchScript: async (url) => {
          fetchedUrl = url
          return "#!/usr/bin/env bash\necho install"
        },
        runScript: async (script, env) => {
          scriptValue = script
          capture.env = env
        },
        writeStdoutLine: (line) => logs.push(line),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(fetchedUrl).toBe("https://tryrigg.com/install")
    expect(scriptValue).toContain("echo install")
    expect(capture.env?.["RIGG_VERSION"]).toBe("3.0.0")
    expect(capture.env?.["RIGG_INSTALL_DIR"]).toBe("/Users/me/.local/bin")
    expect(capture.env?.["RIGG_INSTALL_REPO"]).toBe("tryrigg/rigg")
    expect(logs).toEqual(["Upgrading rigg to v3.0.0...", "Upgrade complete."])
  })

  test("runCommand does not forward inherited installer overrides", async () => {
    const capture: { env?: NodeJS.ProcessEnv } = {}

    const result = await runCommand(
      { target: undefined },
      {
        currentVersion: "1.0.0",
        env: {
          PATH: "/usr/bin",
          RIGG_INSTALL_DIR: "/custom/bin",
          RIGG_VERSION: "9.9.9",
        },
        execPath: "/Users/me/.local/bin/rigg",
        fetchScript: async () => "#!/usr/bin/env bash\necho install",
        runScript: async (_script, env) => {
          capture.env = env
        },
      },
    )

    expect(result.exitCode).toBe(0)
    expect(capture.env?.["RIGG_VERSION"]).toBeUndefined()
    expect(capture.env?.["RIGG_INSTALL_DIR"]).toBe("/Users/me/.local/bin")
  })
})
