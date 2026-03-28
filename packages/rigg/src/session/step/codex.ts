import type { CodexNode } from "../../workflow/schema"
import { createCodexRuntimeSession } from "../../provider/codex/runtime"
import type { RenderContext } from "../render"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"
import { withProviderSession } from "./provider"
import { applyTemplate } from "./template"

export async function runCodexStep(
  step: CodexNode,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  switch (step.with.kind) {
    case "review":
      return await runCodexReviewStep(step.with, context, options)
    case "turn":
      return await runCodexPromptStep(step.with, context, options)
  }
}

async function runCodexReviewStep(
  reviewConfig: Extract<CodexNode["with"], { kind: "review" }>,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  return await withCodexSession(options, async (session) => {
    return await session.review({
      cwd: options.cwd,
      interactionHandler: options.interactionHandler,
      model: reviewConfig.model,
      onEvent: options.onProviderEvent,
      signal: options.signal,
      target: inferReviewScope(reviewConfig.target, context),
    })
  })
}

async function runCodexPromptStep(
  config: Extract<CodexNode["with"], { kind: "turn" }>,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  return await withCodexSession(options, async (session) => {
    return await session.run({
      collaborationMode: config.collaboration_mode === "plan" ? "plan" : undefined,
      cwd: options.cwd,
      effort: config.effort,
      interactionHandler: options.interactionHandler,
      model: config.model,
      onEvent: options.onProviderEvent,
      prompt: applyTemplate(config.prompt, context),
      signal: options.signal,
    })
  })
}

function inferReviewScope(
  target: Extract<CodexNode["with"], { kind: "review" }>["target"],
  context: RenderContext,
): { type: "base"; value: string } | { type: "commit"; value: string } | { type: "uncommitted" } {
  if (target.type === "base") {
    return { type: "base", value: applyTemplate(target.branch, context) }
  }
  if (target.type === "commit") {
    return {
      type: "commit",
      value: applyTemplate(target.sha, context),
    }
  }
  return { type: "uncommitted" }
}

async function withCodexSession(
  options: ProviderStepOptions,
  action: (session: Awaited<ReturnType<typeof createCodexRuntimeSession>>) => Promise<ActionStepOutput>,
): Promise<ActionStepOutput> {
  return await withProviderSession(
    options,
    () =>
      createCodexRuntimeSession({
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
      }),
    action,
  )
}
