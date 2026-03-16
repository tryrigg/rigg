import { renderTemplate, renderTemplateString } from "../compile/expr"
import {
  childLoopScope,
  childNodePath,
  loopIterationFrameId,
  parallelBranchFrameId,
  type ActionNode,
  type BranchCase,
  type BranchNode,
  type FrameId,
  type GroupNode,
  type LoopNode,
  type NodePath,
  type ParallelNode,
  type WorkflowStep,
} from "../compile/schema"
import { normalizeError } from "../util/error"
import { createEvaluationError, createStepFailedError } from "./error"
import { preview } from "./node"
import type { RenderContext, StepBinding } from "./render"
import type { FrontierNode } from "./schema"

type PlannerScope = {
  env: Record<string, string | undefined>
  frameId: FrameId
  inputs: Record<string, unknown>
  run: Record<string, unknown>
  steps: Record<string, StepBinding>
}

type BranchSelection = {
  caseNode: BranchCase
  index: number
}

type ExecutableFrontierPlan = {
  nodes: FrontierNode[]
}

export type PreparedStep =
  | {
      env: Record<string, string | undefined>
      kind: "action"
      step: ActionNode
    }
  | {
      env: Record<string, string | undefined>
      kind: "branch"
      selection: BranchSelection | null
      step: BranchNode
    }
  | {
      env: Record<string, string | undefined>
      kind: "group"
      step: GroupNode
    }
  | {
      env: Record<string, string | undefined>
      kind: "loop"
      step: LoopNode
    }
  | {
      branchReleasedFrontierNodePaths: NodePath[][]
      env: Record<string, string | undefined>
      kind: "parallel"
      step: ParallelNode
    }
  | {
      kind: "skipped"
      step: WorkflowStep
    }

export function prepareStep(step: WorkflowStep, nodePath: NodePath, scope: PlannerScope, cwd: string): PreparedStep {
  const context = createRenderContext(scope.env, scope.inputs, scope.run, scope.steps)
  if (step.if !== undefined && !Boolean(evaluateExpression(step.if, context))) {
    return { kind: "skipped", step }
  }

  const stepEnv = renderEnvironment(step.env ?? {}, context)
  const env = { ...scope.env, ...stepEnv }
  const mergedContext = createRenderContext(env, scope.inputs, scope.run, scope.steps)

  switch (step.type) {
    case "shell":
    case "codex":
    case "write_file":
      return {
        env,
        kind: "action",
        step,
      }
    case "group":
      return {
        env,
        kind: "group",
        step,
      }
    case "loop":
      return {
        env,
        kind: "loop",
        step,
      }
    case "branch":
      return {
        env,
        kind: "branch",
        selection: selectBranchCase(step, mergedContext) ?? null,
        step,
      }
    case "parallel":
      return {
        branchReleasedFrontierNodePaths: planParallelFrontier(step, nodePath, scope.frameId, mergedContext, cwd).map(
          (plan) => plan.nodes.map((node) => node.node_path),
        ),
        env,
        kind: "parallel",
        step,
      }
  }
}

export function frontierForPreparedStep(
  prepared: PreparedStep,
  nodePath: NodePath,
  scope: PlannerScope,
  cwd: string,
): FrontierNode[] {
  switch (prepared.kind) {
    case "action":
      return [
        createFrontierNode(
          prepared.step,
          nodePath,
          scope.frameId,
          prepared.env,
          scope.inputs,
          scope.run,
          scope.steps,
          cwd,
        ),
      ]
    case "parallel":
      return planParallelFrontier(
        prepared.step,
        nodePath,
        scope.frameId,
        createRenderContext(prepared.env, scope.inputs, scope.run, scope.steps),
        cwd,
      ).flatMap((plan) => plan.nodes)
    case "branch":
    case "group":
    case "loop":
    case "skipped":
      return []
  }
}

export function evaluateExpression(template: string, context: RenderContext): unknown {
  try {
    return renderTemplate(template, context)
  } catch (error) {
    throw createEvaluationError(error)
  }
}

export function renderEnvironment(envMap: Record<string, string>, context: RenderContext): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(envMap)) {
    try {
      entries.push([key, renderTemplateString(value, context)])
    } catch (error) {
      throw createStepFailedError(error)
    }
  }

  return Object.fromEntries(entries)
}

function planParallelFrontier(
  step: ParallelNode,
  nodePath: NodePath,
  frameId: FrameId,
  context: RenderContext,
  cwd: string,
): ExecutableFrontierPlan[] {
  return step.branches.map((branch, index) => {
    const branchFrameId = parallelBranchFrameId(frameId, nodePath, index)
    return {
      nodes: planBlockFrontier(
        branch.steps,
        `${nodePath}/${index}`,
        branchFrameId,
        context,
        cwd,
        `branch=${branch.id}`,
      ),
    }
  })
}

function planBlockFrontier(
  steps: WorkflowStep[],
  pathPrefix: NodePath,
  frameId: FrameId,
  context: RenderContext,
  cwd: string,
  detailOverride?: string,
): FrontierNode[] {
  for (const [index, step] of steps.entries()) {
    const frontier = planStepFrontier(step, childNodePath(pathPrefix, index), frameId, context, cwd, detailOverride)
    if (frontier.length > 0) {
      return frontier
    }
  }

  return []
}

function planStepFrontier(
  step: WorkflowStep,
  nodePath: NodePath,
  frameId: FrameId,
  context: RenderContext,
  cwd: string,
  detailOverride?: string,
): FrontierNode[] {
  if (step.if !== undefined && !Boolean(evaluateExpression(step.if, context))) {
    return []
  }

  const stepEnv = renderEnvironment(step.env ?? {}, context)
  const mergedContext = createRenderContext({ ...context.env, ...stepEnv }, context.inputs, context.run, context.steps)

  switch (step.type) {
    case "shell":
    case "codex":
    case "write_file":
      return [
        createFrontierNode(
          step,
          nodePath,
          frameId,
          mergedContext.env,
          mergedContext.inputs,
          mergedContext.run,
          mergedContext.steps,
          cwd,
          detailOverride,
        ),
      ]
    case "group":
      return planBlockFrontier(step.steps, nodePath, frameId, mergedContext, cwd, detailOverride)
    case "loop": {
      const iterationFrameId = loopIterationFrameId(childLoopScope(frameId, nodePath), 1)
      return planBlockFrontier(
        step.steps,
        nodePath,
        iterationFrameId,
        createRenderContext(
          mergedContext.env,
          mergedContext.inputs,
          {
            iteration: 1,
            max_iterations: step.max,
            node_path: nodePath,
          },
          mergedContext.steps,
        ),
        cwd,
        detailOverride,
      )
    }
    case "branch": {
      const selection = selectBranchCase(step, mergedContext)
      if (selection === undefined) {
        return []
      }

      return planBlockFrontier(
        selection.caseNode.steps,
        `${nodePath}/${selection.index}`,
        frameId,
        mergedContext,
        cwd,
        detailOverride,
      )
    }
    case "parallel":
      return planParallelFrontier(step, nodePath, frameId, mergedContext, cwd).flatMap((plan) => plan.nodes)
  }
}

function selectBranchCase(step: BranchNode, context: RenderContext): BranchSelection | undefined {
  let fallback: BranchSelection | undefined

  for (const [index, caseNode] of step.cases.entries()) {
    if (caseNode.else === true) {
      fallback ??= { caseNode, index }
      continue
    }

    if (Boolean(evaluateExpression(caseNode.if ?? "", context))) {
      return { caseNode, index }
    }
  }

  return fallback
}

function createFrontierNode(
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
    action: step.type === "codex" ? step.with.action : null,
    cwd: step.type === "codex" ? cwd : null,
    detail: detailOverride ?? summarizeFrontierDetail(step),
    frame_id: frameId,
    model: step.type === "codex" ? (step.with.model ?? null) : null,
    node_kind: step.type,
    node_path: nodePath,
    prompt_preview: frontierPromptPreview(step, context),
    user_id: step.id ?? null,
  }
}

function createRenderContext(
  env: Record<string, string | undefined>,
  inputs: Record<string, unknown>,
  run: Record<string, unknown>,
  steps: Record<string, StepBinding>,
): RenderContext {
  return {
    env,
    inputs,
    run,
    steps,
  }
}

function summarizeFrontierDetail(step: ActionNode): string | null {
  if (step.type === "shell") {
    return step.with.command
  }
  if (step.type === "write_file") {
    return step.with.path
  }

  return step.with.action === "review" ? "codex review" : "codex run"
}

function frontierPromptPreview(step: ActionNode, context: RenderContext): string | null {
  if (step.type === "codex" && step.with.action === "run") {
    return preview(renderStringSafely(step.with.prompt, context))
  }
  if (step.type === "codex" && step.with.action === "review") {
    return summarizeReviewPreview(step, context)
  }

  return null
}

function summarizeReviewPreview(step: Extract<ActionNode, { type: "codex" }>, context: RenderContext): string {
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
  } catch (error) {
    const message = normalizeError(error).message
    if (message.length === 0) {
      return `${template} (preview unavailable)`
    }

    return `${template} (preview unavailable: ${message})`
  }
}
