import { describe, expect, test } from "bun:test"

import { spawnSpec } from "../../src/util/spawn"

describe("util/spawn", () => {
  test("resolves executables directly on non-Windows platforms", () => {
    const result = spawnSpec("codex", ["app-server"], {
      cwd: "/tmp/rigg",
      env: { PATH: "/tmp/bin" },
      platform: "darwin",
      resolve: (command, options) => {
        expect(command).toBe("codex")
        expect(options).toEqual({ PATH: "/tmp/bin", cwd: "/tmp/rigg" })
        return "/tmp/bin/codex"
      },
    })

    expect(result).toEqual({
      cmd: ["/tmp/bin/codex", "app-server"],
    })
  })

  test("falls back to the original command when resolution fails on non-Windows platforms", () => {
    const result = spawnSpec("cursor", ["--version"], {
      cwd: "/tmp/rigg",
      env: {},
      platform: "linux",
      resolve: () => null,
    })

    expect(result).toEqual({
      cmd: ["cursor", "--version"],
    })
  })

  test("wraps Windows commands in cmd.exe so .cmd shims remain launchable", () => {
    const result = spawnSpec("codex", ["app-server"], {
      cwd: "C:\\work\\rigg",
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Users\\user\\AppData\\Local\\npm",
      },
      platform: "win32",
      resolve: () => "C:\\Users\\user\\AppData\\Local\\npm\\codex.cmd",
    })

    expect(result.windowsVerbatimArguments).toBe(true)
    expect(result.cmd.slice(0, 4)).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c"])
    expect(result.cmd[4]).toContain("codex.cmd")
    expect(result.cmd[4]).toContain("app-server")
  })
})
