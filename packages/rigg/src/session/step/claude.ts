import type { ClaudeNode } from "../../workflow/schema"
import { createClaudeRuntimeSession } from "../../claude/runtime"
import { isAbortError } from "../../util/error"
import type { RenderContext } from "../render"
import { interrupt } from "../error"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"
import { applyTemplate } from "./template"

export async function runClaudeStep(
  step: ClaudeNode,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  return await withSession(options, async (session) => {
    return await session.run({
      cwd: options.cwd,
      effort: step.with.effort,
      interactionHandler: options.interactionHandler,
      maxThinkingTokens: step.with.max_thinking_tokens,
      maxTurns: step.with.max_turns,
      model: step.with.model,
      onEvent: options.onProviderEvent,
      permissionMode: mapPermissionMode(step.with.permission_mode),
      prompt: applyTemplate(step.with.prompt, context),
      signal: options.signal,
    })
  })
}

function mapPermissionMode(
  mode: ClaudeNode["with"]["permission_mode"],
): "acceptEdits" | "bypassPermissions" | "default" | "plan" | undefined {
  if (mode === undefined) {
    return undefined
  }
  if (mode === "accept_edits") {
    return "acceptEdits"
  }
  if (mode === "bypass_permissions") {
    return "bypassPermissions"
  }
  return mode
}

async function withSession(
  options: ProviderStepOptions,
  action: (session: Awaited<ReturnType<typeof createClaudeRuntimeSession>>) => Promise<ActionStepOutput>,
): Promise<ActionStepOutput> {
  let session: Awaited<ReturnType<typeof createClaudeRuntimeSession>>
  try {
    session = await createClaudeRuntimeSession({
      cwd: options.cwd,
      env: options.env,
      sdk: options.claudeSdk,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted && isAbortError(error)) {
      throw interrupt("step interrupted", { cause: error })
    }
    throw error
  }

  try {
    return await action(session)
  } finally {
    await session.close()
  }
}
