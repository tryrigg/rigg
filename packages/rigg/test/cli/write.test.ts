import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { exists, writeIfMissing } from "../../src/cli/write"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function createTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rigg-cli-write-"))
  tempDirs.push(path)
  return path
}

describe("cli/write", () => {
  test("exists returns false for a missing path and true after writing", async () => {
    const dir = await createTempDir()
    const path = join(dir, "output.txt")

    expect(await exists(path)).toBe(false)

    await Bun.write(path, "hello")

    expect(await exists(path)).toBe(true)
  })

  test("writeIfMissing writes new files and preserves existing contents", async () => {
    const dir = await createTempDir()
    const path = join(dir, "output.txt")

    await writeIfMissing(path, "first")
    expect(await Bun.file(path).text()).toBe("first")

    await writeIfMissing(path, "second")
    expect(await Bun.file(path).text()).toBe("first")
  })

  test("writeIfMissing skips an existing directory path", async () => {
    const dir = await createTempDir()
    const path = join(dir, "output.txt")

    await mkdir(path)
    await writeIfMissing(path, "ignored")

    expect(await exists(path)).toBe(true)
    expect(await Bun.file(path).exists()).toBe(false)
  })
})
