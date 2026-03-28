import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { assertVersion, resolveBinaryPath } from "../../../src/provider/claude/proc"
import { installFakeClaude } from "../../fixture/fake-claude"

describe("claude/proc", () => {
  test("accepts supported claude versions and resolves the binary path", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-claude-proc-"))
    try {
      const binDir = await installFakeClaude(root, { versionOutput: "claude 2.1.81" })
      const binaryPath = join(binDir, "claude")

      expect(assertVersion({ binaryPath, cwd: root, env: process.env })).toBe("2.1.81")
      expect(
        resolveBinaryPath({ cwd: root, env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` } }),
      ).toBe(binaryPath)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test("reports a clear install message when claude is missing", () => {
    expect(() =>
      assertVersion({
        binaryPath: join("/tmp", "definitely-missing-claude"),
        cwd: process.cwd(),
        env: process.env,
      }),
    ).toThrow("brew install --cask claude-code")
  })

  test("rejects unsupported claude versions with an upgrade message", async () => {
    const root = await mkdtemp(join(tmpdir(), "rigg-claude-old-proc-"))
    try {
      const binDir = await installFakeClaude(root, { versionOutput: "claude 2.1.75" })
      const binaryPath = join(binDir, "claude")

      expect(() => assertVersion({ binaryPath, cwd: root, env: process.env })).toThrow("Upgrade to v2.1.76 or newer")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
