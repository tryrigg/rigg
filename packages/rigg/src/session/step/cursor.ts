import type { CursorNode } from "../../workflow/schema"
import { createCursorRuntimeSession } from "../../cursor/runtime"
import { isAbortError } from "../../util/error"
import type { RenderContext } from "../render"
import { interrupt } from "../error"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"
import { applyTemplate } from "./template"

export async function runCursorStep(
  step: CursorNode,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  let session: Awaited<ReturnType<typeof createCursorRuntimeSession>>
  try {
    session = await createCursorRuntimeSession({
      cwd: options.cwd,
      env: options.env,
      model: step.with.model,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted && isAbortError(error)) {
      throw interrupt("step interrupted", { cause: error })
    }
    throw error
  }

  try {
    return await session.run({
      cwd: options.cwd,
      mode: step.with.mode,
      interactionHandler: options.interactionHandler,
      onEvent: options.onProviderEvent,
      prompt: applyTemplate(step.with.prompt, context),
      signal: options.signal,
    })
  } finally {
    await session.close()
  }
}
