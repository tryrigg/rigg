import { callFrame, loopScope, childPath, loopFrame, parallelFrame, type FrameId, type NodePath } from "../workflow/id"
import type { WorkflowProject } from "../project"
import type { ActionNode, ParallelNode, WorkflowStep } from "../workflow/schema"
import { preview } from "./node"
import type { RenderContext, StepBinding } from "./render"
import type { FrontierNode } from "./schema"
import { callEnv, parseCallInputs } from "./call"
import { createRenderContext, prepareStep, renderStringSafely, type PlannerScope, type PreparedStep } from "./prep"

type ExecutableFrontierPlan = {
  nodes: FrontierNode[]
}

export function frontierForPreparedStep(
  prepared: PreparedStep,
  _nodePath: NodePath,
  _scope: PlannerScope,
  _cwd: string,
): FrontierNode[] {
  switch (prepared.kind) {
    case "action":
      return prepared.frontier
    case "parallel":
      return prepared.frontier
    case "workflow":
      return prepared.frontier
    case "branch":
    case "group":
    case "loop":
    case "skipped":
      return prepared.frontier
  }
}

export function planParallelFrontier(
  step: ParallelNode,
  nodePath: NodePath,
  scope: Pick<PlannerScope, "activeWorkflowIds" | "frameId">,
  context: RenderContext,
  cwd: string,
  project?: WorkflowProject,
): ExecutableFrontierPlan[] {
  return step.branches.map((branch, index) => {
    const branchFrameId = parallelFrame(scope.frameId, nodePath, index)
    return {
      nodes: planBlockFrontier(
        branch.steps,
        `${nodePath}/${index}`,
        {
          activeWorkflowIds: scope.activeWorkflowIds,
          frameId: branchFrameId,
        },
        context,
        cwd,
        project,
        `branch=${branch.id}`,
      ),
    }
  })
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
          prepared.env,
          context.inputs,
          context.run,
          context.steps,
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
      return detailOverride === undefined
        ? frontierPlans.flatMap((plan) => plan.nodes)
        : frontierPlans.flatMap((plan) => plan.nodes)
    }
  }
}

export function createFrontierNode(
  step: ActionNode,
  nodePath: NodePath,
  frameId: FrameId,
  env: Record<string, string | undefined>,
  inputs: Record<string, unknown>,
  run: Record<string, unknown>,
  steps: Record<string, StepBinding>,
  cwd: string,
  detailOverride?: string,
): FrontierNode {
  const context = createRenderContext(env, inputs, run, steps)

  return {
    action: step.type === "codex" || step.type === "cursor" ? step.with.action : null,
    cwd: step.type === "codex" || step.type === "cursor" ? cwd : null,
    detail: detailOverride ?? summarizeFrontierDetail(step),
    frame_id: frameId,
    model: step.type === "codex" ? (step.with.model ?? null) : null,
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
    return `cursor ${step.with.action}`
  }

  if (step.with.action === "review") {
    return "codex review"
  }
  if (step.with.action === "plan") {
    return "codex plan"
  }

  return "codex run"
}

export function frontierPromptPreview(step: ActionNode, context: RenderContext): string | null {
  if (step.type === "cursor") {
    return preview(renderStringSafely(step.with.prompt, context))
  }
  if (step.type === "codex" && step.with.action !== "review") {
    return preview(renderStringSafely(step.with.prompt, context))
  }
  if (step.type === "codex" && step.with.action === "review") {
    return summarizeReviewPreview(step, context)
  }

  return null
}

export function summarizeReviewPreview(step: Extract<ActionNode, { type: "codex" }>, context: RenderContext): string {
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
