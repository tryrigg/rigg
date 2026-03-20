import { constants } from "node:fs"
import { access } from "node:fs/promises"

import { isMissingPathError } from "../util/error"

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if (isMissingPathError(error)) {
      return false
    }
    throw error
  }
}

export async function writeIfMissing(path: string, contents: string): Promise<void> {
  if (await exists(path)) {
    return
  }

  await Bun.write(path, contents)
}
