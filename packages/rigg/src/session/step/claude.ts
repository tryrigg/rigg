import type { ClaudeNode } from "../../workflow/schema"
import { createClaudeRuntimeSession } from "../../provider/claude/runtime"
import type { RenderContext } from "../render"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"
import { withProviderSession } from "./provider"
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
  return await withProviderSession(
    options,
    () =>
      createClaudeRuntimeSession({
        cwd: options.cwd,
        env: options.env,
        sdk: options.claudeSdk,
        signal: options.signal,
      }),
    action,
  )
}
