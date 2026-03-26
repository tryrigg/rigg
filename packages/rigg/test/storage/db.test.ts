import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { closeDb, openDb, resolveDbPath } from "../../src/storage/db"
import { cleanupTempDirs, createTempDir } from "../fixture/history"

const tempDirs: string[] = []

afterEach(async () => {
  await cleanupTempDirs(tempDirs)
})

describe("storage/db", () => {
  test("open creates a database when missing", async () => {
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    const result = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") {
      return
    }

    closeDb(result.db)
    expect(await Bun.file(join(dataHome, "rigg", "rigg.db")).exists()).toBe(true)
  })

  test("store path falls back to an invocation-scoped temp directory when HOME and XDG are unset", () => {
    const a = resolveDbPath({})
    const b = resolveDbPath({})

    expect(a).toBe(b)
    expect(a).toStartWith(join(tmpdir(), "rigg"))
    expect(a).toEndWith(join("rigg.db"))
    expect(a).not.toBe(join(tmpdir(), "rigg", "rigg.db"))
  })

  test("failed migration preserves the error and cleans up a fresh database", async () => {
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    const missingMigrations = join(dataHome, "missing-drizzle")

    const result = await openDb({
      env: { XDG_DATA_HOME: dataHome },
      migrationsFolder: missingMigrations,
    })

    expect(result.kind).toBe("disabled")
    if (result.kind !== "disabled") {
      return
    }

    expect(result.warning.join("\n")).toContain("auto-migrate failed")
    expect(result.warning.join("\n")).toContain(missingMigrations)
    expect(result.warning.join("\n")).toContain(`Can't find migrations at ${missingMigrations}`)
    expect(await Bun.file(join(dataHome, "rigg", "rigg.db")).exists()).toBe(false)

    const retry = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(retry.kind).toBe("ok")
    if (retry.kind !== "ok") {
      return
    }
    closeDb(retry.db)
  })

  test("existing databases still require migration assets", async () => {
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    const missingMigrations = join(dataHome, "missing-drizzle")

    const setup = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(setup.kind).toBe("ok")
    if (setup.kind !== "ok") {
      return
    }
    closeDb(setup.db)

    const result = await openDb({
      env: { XDG_DATA_HOME: dataHome },
      migrationsFolder: missingMigrations,
    })

    expect(result.kind).toBe("disabled")
    if (result.kind !== "disabled") {
      return
    }

    expect(result.warning.join("\n")).toContain("auto-migrate failed")
    expect(result.warning.join("\n")).toContain(`Can't find migrations at ${missingMigrations}`)
  })

  test("create open failures keep the open warning path", async () => {
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    const dbPath = join(dataHome, "rigg", "rigg.db")
    await mkdir(join(dataHome, "rigg"), { recursive: true })
    await Bun.write(dbPath, "not a sqlite database")

    const result = await openDb({
      env: { XDG_DATA_HOME: dataHome },
    })

    expect(result.kind).toBe("disabled")
    if (result.kind !== "disabled") {
      return
    }

    expect(result.warning.join("\n")).toContain("Run history database is corrupted")
    expect(result.warning.join("\n")).not.toContain("needs migration")
  })

  test("concurrent first opens serialize migrations and keep history enabled", async () => {
    const dataHome = await createTempDir(tempDirs, "rigg-data-")
    const gate = join(dataHome, "start")
    const pending = [
      Bun.spawn({
        cmd: [
          "bun",
          "--eval",
          `
            const mod = await import(${JSON.stringify(new URL("../../src/storage/db.ts", import.meta.url).href)})
            const input = ${JSON.stringify({ dataHome, gate })}
            while (!(await Bun.file(input.gate).exists())) {
              await Bun.sleep(10)
            }
            const result = await mod.openDb({ env: { XDG_DATA_HOME: input.dataHome } })
            if (result.kind === "ok") {
              mod.closeDb(result.db)
            }
            console.log(JSON.stringify(result.kind === "ok" ? { kind: result.kind } : result))
          `,
        ],
        cwd: process.cwd(),
        env: process.env,
        stderr: "pipe",
        stdout: "pipe",
      }),
      Bun.spawn({
        cmd: [
          "bun",
          "--eval",
          `
            const mod = await import(${JSON.stringify(new URL("../../src/storage/db.ts", import.meta.url).href)})
            const input = ${JSON.stringify({ dataHome, gate })}
            while (!(await Bun.file(input.gate).exists())) {
              await Bun.sleep(10)
            }
            const result = await mod.openDb({ env: { XDG_DATA_HOME: input.dataHome } })
            if (result.kind === "ok") {
              mod.closeDb(result.db)
            }
            console.log(JSON.stringify(result.kind === "ok" ? { kind: result.kind } : result))
          `,
        ],
        cwd: process.cwd(),
        env: process.env,
        stderr: "pipe",
        stdout: "pipe",
      }),
    ]

    await Bun.sleep(50)
    await Bun.write(gate, "")

    const results = await Promise.all(
      pending.map(async (proc) => {
        const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        const code = await proc.exited
        if (code !== 0) {
          throw new Error(stderr || `worker exited with code ${code}`)
        }
        return JSON.parse(stdout.trim())
      }),
    )
    expect(results).toEqual([expect.objectContaining({ kind: "ok" }), expect.objectContaining({ kind: "ok" })])

    const readResult = await openDb({ env: { XDG_DATA_HOME: dataHome } })
    expect(readResult.kind).toBe("ok")
    if (readResult.kind !== "ok") {
      return
    }
    closeDb(readResult.db)
  })
})
