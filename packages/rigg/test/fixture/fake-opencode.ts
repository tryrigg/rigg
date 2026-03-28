import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function installFakeOpenCode(
  root: string,
  options: { versionOutput?: string | undefined } = {},
): Promise<string> {
  const binDir = join(root, "bin")
  await mkdir(binDir, { recursive: true })

  const runnerPath = join(binDir, "fake-opencode.mjs")
  await writeFile(
    runnerPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(options.versionOutput ?? "opencode 1.3.3")} + "\\n")
  process.exit(0)
}
process.stderr.write("unsupported fake opencode invocation\\n")
process.exit(1)
`,
    "utf8",
  )

  const wrapperPath = join(binDir, "opencode")
  await writeFile(
    wrapperPath,
    [`#!/bin/sh`, `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)} "$@"`].join("\n"),
    "utf8",
  )
  await chmod(wrapperPath, 0o755)
  return binDir
}
