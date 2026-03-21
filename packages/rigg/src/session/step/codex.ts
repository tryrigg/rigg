import type { CodexNode } from "../../workflow/schema"
import { renderString } from "../../workflow/expr"
import { createCodexRuntimeSession } from "../../codex/runtime"
import { isAbortError } from "../../util/error"
import type { RenderContext } from "../render"
import { stepFailed, interrupt } from "../error"
import type { ActionStepOutput, ProviderStepOptions } from "./shell"

export async function runCodexStep(
  step: CodexNode,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  switch (step.with.action) {
    case "review":
      return await runCodexReviewStep(step.with, context, options)
    case "plan":
      return await runCodexPromptStep(step.with, context, options)
    case "run":
      return await runCodexPromptStep(step.with, context, options)
  }
}

function applyTemplate(template: string, context: RenderContext): string {
  try {
    return renderString(template, context)
  } catch (error) {
    throw stepFailed(error)
  }
}

async function runCodexReviewStep(
  reviewConfig: Extract<CodexNode["with"], { action: "review" }>,
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
      target: inferReviewScope(reviewConfig.review, context),
    })
  })
}

async function runCodexPromptStep(
  config: Extract<CodexNode["with"], { action: "plan" | "run" }>,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  return await withCodexSession(options, async (session) => {
    return await session.run({
      collaborationMode: config.action === "plan" ? "plan" : undefined,
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
  review: CodexNode["with"] extends infer T
    ? T extends { action: "review"; review: infer ReviewConfig }
      ? ReviewConfig
      : never
    : never,
  context: RenderContext,
): { type: "base"; value: string } | { type: "commit"; value: string } | { type: "uncommitted" } {
  const target = review.target
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
  let session: Awaited<ReturnType<typeof createCodexRuntimeSession>>
  try {
    session = await createCodexRuntimeSession({
      cwd: options.cwd,
      env: options.env,
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
