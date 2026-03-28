import { isAbortError } from "../../util/error"
import { interrupt } from "../error"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"

type Closable = {
  close: () => Promise<void>
}

export async function withProviderAbort<T>(options: ProviderStepOptions, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (options.signal?.aborted && isAbortError(error)) {
      throw interrupt("step interrupted", { cause: error })
    }
    throw error
  }
}

export async function withProviderSession<T extends Closable>(
  options: ProviderStepOptions,
  create: () => Promise<T>,
  run: (session: T) => Promise<ActionStepOutput>,
): Promise<ActionStepOutput> {
  const session = await withProviderAbort(options, create)
  try {
    return await run(session)
  } finally {
    await session.close()
  }
}
