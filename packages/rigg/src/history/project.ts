import { lstat } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export type ProjectRootDiscoveryResult = { kind: "found"; rootDir: string } | { kind: "not_found"; message: string }

export async function discoverProjectRoot(startDir: string): Promise<ProjectRootDiscoveryResult> {
  let currentDir = resolve(startDir)

  for (;;) {
    try {
      const stat = await lstat(resolve(currentDir, ".rigg"))
      if (stat.isDirectory()) {
        return { kind: "found", rootDir: currentDir }
      }
    } catch {
      // keep walking
    }

    const parent = dirname(currentDir)
    if (parent === currentDir) {
      return {
        kind: "not_found",
        message: `Could not find a .rigg directory from \`${startDir}\`.`,
      }
    }

    currentDir = parent
  }
}
