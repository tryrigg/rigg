import { mkdir } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

export async function runWriteFileStep(path: string, content: string, cwd: string): Promise<{ path: string }> {
  const resolvedPath = isAbsolute(path) ? path : join(cwd, path)
  await mkdir(dirname(resolvedPath), { recursive: true })
  await Bun.write(resolvedPath, content)
  return { path: resolvedPath }
}
