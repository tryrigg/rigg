import type { OpenCodeNode } from "../../workflow/schema"
import { createOpencodeRuntimeSession } from "../../opencode/runtime"
import type { RenderContext } from "../render"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"
import { withProviderAbort, withProviderSession } from "./provider"
import { applyTemplate } from "./template"

export async function runOpenCodeStep(
  step: OpenCodeNode,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  const prompt = applyTemplate(step.with.prompt, context).trim()
  if (prompt.length === 0) {
    return {
      exitCode: 1,
      providerEvents: [],
      result: null,
      stderr: "OpenCode prompt rendered to an empty string. Update `with.prompt` so it produces non-empty text.",
      stdout: "",
      termination: "failed",
    }
  }

  return await withProviderSession(
    options,
    () =>
      createOpencodeRuntimeSession({
        binaryPath: options.opencodeBinaryPath,
        cwd: options.cwd,
        env: options.env,
        internals: options.opencodeInternals,
        scopeId: options.opencodeScopeId ?? options.cwd,
        signal: options.signal,
      }),
    async (session) => {
      return await withProviderAbort(options, async () => {
        return await session.run({
          agent: step.with.agent,
          cwd: options.cwd,
          interactionHandler: options.interactionHandler,
          model: step.with.model,
          onEvent: options.onProviderEvent,
          permissionMode: step.with.permission_mode,
          prompt,
          signal: options.signal,
          variant: step.with.variant,
        })
      })
    },
  )
}
