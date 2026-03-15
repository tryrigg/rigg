import { renderTemplateString } from "../compile/expr"
import {
  parallelBranchFrameId,
  type FrameId,
  type NodePath,
  type ParallelNode,
  type WorkflowStep,
} from "../compile/schema"
import { preview } from "./node"
import type { RenderContext } from "./render"
import type { FrontierNode } from "./schema"

export function shouldPauseBeforeStep(step: WorkflowStep): boolean {
  return step.type === "shell" || step.type === "codex" || step.type === "write_file" || step.type === "parallel"
}

export function describeFrontier(
  step: WorkflowStep,
  nodePath: NodePath,
  frameId: FrameId,
  context: RenderContext,
  cwd: string,
): FrontierNode[] {
  if (step.type === "parallel") {
    return describeParallelFrontier(step, nodePath, frameId, context, cwd)
  }

  return [
    {
      action: step.type === "codex" ? step.with.action : null,
      cwd: step.type === "codex" ? cwd : null,
      detail: summarizeFrontierDetail(step),
      frame_id: frameId,
      model: step.type === "codex" ? (step.with.model ?? null) : null,
      node_kind: step.type,
      node_path: nodePath,
      prompt_preview: frontierPromptPreview(step, context),
      user_id: step.id ?? null,
    },
  ]
}

export function describeParallelFrontier(
  step: ParallelNode,
  nodePath: NodePath,
  frameId: FrameId,
  context: RenderContext,
  cwd: string,
): FrontierNode[] {
  return step.branches.flatMap((branch, index) => {
    const branchFrameId = parallelBranchFrameId(frameId, nodePath, index)
    const firstStep = branch.steps[0]
    if (firstStep === undefined) {
      return []
    }

    return [
      {
        action: firstStep.type === "codex" ? firstStep.with.action : null,
        cwd: firstStep.type === "codex" ? cwd : null,
        detail: branch.id === undefined ? "parallel branch" : `branch=${branch.id}`,
        frame_id: branchFrameId,
        model: firstStep.type === "codex" ? (firstStep.with.model ?? null) : null,
        node_kind: firstStep.type,
        node_path: `${nodePath}/${index}/0`,
        prompt_preview: frontierPromptPreview(firstStep, context),
        user_id: firstStep.id ?? null,
      },
    ]
  })
}

function summarizeFrontierDetail(step: WorkflowStep): string | null {
  if (step.type === "shell") {
    return step.with.command
  }
  if (step.type === "write_file") {
    return step.with.path
  }
  if (step.type === "codex") {
    return step.with.action === "review" ? "codex review" : "codex run"
  }

  return null
}

function frontierPromptPreview(step: WorkflowStep, context: RenderContext): string | null {
  if (step.type === "codex" && step.with.action === "run") {
    return preview(renderStringSafely(step.with.prompt, context))
  }
  if (step.type === "codex" && step.with.action === "review") {
    return summarizeReviewPreview(step, context)
  }

  return null
}

function summarizeReviewPreview(step: Extract<WorkflowStep, { type: "codex" }>, context: RenderContext): string {
  if (step.with.action !== "review") {
    return "codex review"
  }

  const target = step.with.review.target
  if (target.type === "uncommitted") {
    return "review uncommitted changes"
  }
  if (target.type === "base") {
    return `review base ${renderStringSafely(target.branch, context)}`
  }

  return `review commit ${renderStringSafely(target.sha, context)}`
}

function renderStringSafely(template: string, context: RenderContext): string {
  try {
    return renderTemplateString(template, context)
  } catch {
    return template
  }
}
