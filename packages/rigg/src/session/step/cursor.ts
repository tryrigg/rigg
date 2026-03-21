import type { CursorNode } from "../../workflow/schema"
import { renderString } from "../../workflow/expr"
import { createCursorRuntimeSession } from "../../cursor/runtime"
import { isAbortError } from "../../util/error"
import type { RenderContext } from "../render"
import { interrupt, stepFailed } from "../error"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"

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
      action: step.with.action,
      cwd: options.cwd,
      interactionHandler: options.interactionHandler,
      onEvent: (event) => options.onProviderEvent?.(event),
      prompt: applyTemplate(step.with.prompt, context),
      signal: options.signal,
    })
  } finally {
    await session.close()
  }
}

function applyTemplate(template: string, context: RenderContext): string {
  try {
    return renderString(template, context)
  } catch (error) {
    throw stepFailed(error)
  }
}
