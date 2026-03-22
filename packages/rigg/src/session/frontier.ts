import { callFrame, loopScope, childPath, loopFrame, parallelFrame, type FrameId, type NodePath } from "../workflow/id"
import type { WorkflowProject } from "../project"
import type { ActionNode, ParallelNode, WorkflowStep } from "../workflow/schema"
import { preview } from "./node"
import type { RenderContext } from "./render"
import type { FrontierNode } from "./schema"
import { callEnv, parseCallInputs } from "./call"
import { createRenderContext, prepareStep, renderStringSafely, type PlannerScope } from "./prep"

export function planParallelFrontier(
  step: ParallelNode,
  nodePath: NodePath,
  scope: Pick<PlannerScope, "activeWorkflowIds" | "frameId">,
  context: RenderContext,
  cwd: string,
  project?: WorkflowProject,
): { nodes: FrontierNode[] }[] {
  return step.branches.map((branch, index) => ({
    nodes: planBlockFrontier(
      branch.steps,
      `${nodePath}/${index}`,
      {
        activeWorkflowIds: scope.activeWorkflowIds,
        frameId: parallelFrame(scope.frameId, nodePath, index),
      },
      context,
      cwd,
      project,
      `branch=${branch.id}`,
    ),
  }))
}

export function planBlockFrontier(
  steps: WorkflowStep[],
  pathPrefix: NodePath,
  scope: Pick<PlannerScope, "activeWorkflowIds" | "frameId">,
  context: RenderContext,
  cwd: string,
  project?: WorkflowProject,
  detailOverride?: string,
): FrontierNode[] {
  for (const [index, step] of steps.entries()) {
    const frontier = planStepFrontier(step, childPath(pathPrefix, index), scope, context, cwd, project, detailOverride)
    if (frontier.length > 0) {
      return frontier
    }
  }

  return []
}

export function planStepFrontier(
  step: WorkflowStep,
  nodePath: NodePath,
  scope: Pick<PlannerScope, "activeWorkflowIds" | "frameId">,
  context: RenderContext,
  cwd: string,
  project?: WorkflowProject,
  detailOverride?: string,
): FrontierNode[] {
  const prepared = prepareStep(
    step,
    nodePath,
    {
      activeWorkflowIds: scope.activeWorkflowIds,
      env: context.env,
      frameId: scope.frameId,
      inputs: context.inputs,
      run: context.run,
      steps: context.steps,
    },
    cwd,
    project,
  )

  switch (prepared.kind) {
    case "skipped":
      return []
    case "action":
      return [
        createFrontierNode(
          prepared.step,
          nodePath,
          scope.frameId,
          createRenderContext(prepared.env, context.inputs, context.run, context.steps),
          cwd,
          detailOverride,
        ),
      ]
    case "group":
      return planBlockFrontier(
        prepared.step.steps,
        nodePath,
        scope,
        createRenderContext(prepared.env, context.inputs, context.run, context.steps),
        cwd,
        project,
        detailOverride,
      )
    case "loop": {
      const iterationFrameId = loopFrame(loopScope(scope.frameId, nodePath), 1)
      return planBlockFrontier(
        prepared.step.steps,
        nodePath,
        {
          activeWorkflowIds: scope.activeWorkflowIds,
          frameId: iterationFrameId,
        },
        createRenderContext(
          prepared.env,
          context.inputs,
          {
            iteration: 1,
            max_iterations: prepared.step.max,
            node_path: nodePath,
          },
          context.steps,
        ),
        cwd,
        project,
        detailOverride,
      )
    }
    case "workflow": {
      if (prepared.workflow === undefined) {
        return []
      }

      const normalizedInputs = parseCallInputs({
        inputs: prepared.inputs,
        nodePath,
        step: prepared.step,
        workflow: prepared.workflow,
      })

      return planBlockFrontier(
        prepared.workflow.steps,
        nodePath,
        {
          activeWorkflowIds: [...scope.activeWorkflowIds, prepared.workflow.id],
          frameId: callFrame(scope.frameId, nodePath),
        },
        createRenderContext(callEnv(prepared.env, prepared.workflow, normalizedInputs), normalizedInputs, {}, {}),
        cwd,
        project,
        detailOverride,
      )
    }
    case "branch": {
      const selection = prepared.selection
      if (selection === null) {
        return []
      }

      return planBlockFrontier(
        selection.caseNode.steps,
        `${nodePath}/${selection.index}`,
        scope,
        createRenderContext(prepared.env, context.inputs, context.run, context.steps),
        cwd,
        project,
        detailOverride,
      )
    }
    case "parallel": {
      const frontierPlans = planParallelFrontier(
        prepared.step,
        nodePath,
        {
          activeWorkflowIds: scope.activeWorkflowIds,
          frameId: scope.frameId,
        },
        createRenderContext(prepared.env, context.inputs, context.run, context.steps),
        cwd,
        project,
      )
      return frontierPlans.flatMap((plan) => plan.nodes)
    }
  }
}

export function createFrontierNode(
  step: ActionNode,
  nodePath: NodePath,
  frameId: FrameId,
  context: RenderContext,
  cwd: string,
  detailOverride?: string,
): FrontierNode {
  if (step.type === "codex") {
    if (step.with.kind === "review") {
      return {
        codex_collaboration_mode: null,
        codex_kind: "review",
        cursor_mode: null,
        cwd,
        detail: detailOverride ?? summarizeFrontierDetail(step),
        frame_id: frameId,
        model: step.with.model ?? null,
        node_kind: step.type,
        node_path: nodePath,
        prompt_preview: frontierPromptPreview(step, context),
        user_id: step.id ?? null,
      }
    }
    return {
      codex_collaboration_mode: step.with.collaboration_mode ?? "default",
      codex_kind: "turn",
      cursor_mode: null,
      cwd,
      detail: detailOverride ?? summarizeFrontierDetail(step),
      frame_id: frameId,
      model: step.with.model ?? null,
      node_kind: step.type,
      node_path: nodePath,
      prompt_preview: frontierPromptPreview(step, context),
      user_id: step.id ?? null,
    }
  }
  if (step.type === "cursor") {
    return {
      codex_collaboration_mode: null,
      codex_kind: null,
      cursor_mode: step.with.mode,
      cwd,
      detail: detailOverride ?? summarizeFrontierDetail(step),
      frame_id: frameId,
      model: step.with.model ?? null,
      node_kind: step.type,
      node_path: nodePath,
      prompt_preview: frontierPromptPreview(step, context),
      user_id: step.id ?? null,
    }
  }
  return {
    codex_collaboration_mode: null,
    codex_kind: null,
    cursor_mode: null,
    cwd: null,
    detail: detailOverride ?? summarizeFrontierDetail(step),
    frame_id: frameId,
    model: null,
    node_kind: step.type,
    node_path: nodePath,
    prompt_preview: frontierPromptPreview(step, context),
    user_id: step.id ?? null,
  }
}

export function summarizeFrontierDetail(step: ActionNode): string | null {
  if (step.type === "shell") {
    return step.with.command
  }
  if (step.type === "write_file") {
    return step.with.path
  }
  if (step.type === "cursor") {
    return `cursor ${step.with.mode}`
  }

  if (step.with.kind === "review") {
    return "codex review"
  }
  if (step.with.collaboration_mode === "plan") {
    return "codex turn · plan"
  }

  return "codex turn"
}

function frontierPromptPreview(step: ActionNode, context: RenderContext): string | null {
  if (step.type === "cursor") {
    return preview(renderStringSafely(step.with.prompt, context))
  }
  if (step.type !== "codex") {
    return null
  }
  if (step.with.kind === "review") {
    const target = step.with.target
    if (target.type === "uncommitted") return "review uncommitted changes"
    if (target.type === "base") return `review base ${renderStringSafely(target.branch, context)}`
    return `review commit ${renderStringSafely(target.sha, context)}`
  }
  return preview(renderStringSafely(step.with.prompt, context))
}
