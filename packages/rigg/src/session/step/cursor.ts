import type { CursorNode } from "../../workflow/schema"
import { createCursorRuntimeSession } from "../../cursor/runtime"
import type { RenderContext } from "../render"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"
import { withProviderSession } from "./provider"
import { applyTemplate } from "./template"

export async function runCursorStep(
  step: CursorNode,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  return await withProviderSession(
    options,
    () =>
      createCursorRuntimeSession({
        cwd: options.cwd,
        env: options.env,
        model: step.with.model,
        signal: options.signal,
      }),
    async (session) => {
      return await session.run({
        cwd: options.cwd,
        mode: step.with.mode,
        interactionHandler: options.interactionHandler,
        onEvent: options.onProviderEvent,
        prompt: applyTemplate(step.with.prompt, context),
        signal: options.signal,
      })
    },
  )
}
