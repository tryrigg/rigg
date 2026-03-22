import { renderTemplate, renderString } from "../workflow/expr"
import { callFrame, type FrameId, type NodePath } from "../workflow/id"
import type { WorkflowProject } from "../project"
import type {
  ActionNode,
  BranchCase,
  BranchNode,
  GroupNode,
  LoopNode,
  ParallelNode,
  WorkflowDocument,
  WorkflowNode,
  WorkflowStep,
} from "../workflow/schema"
import { normalizeError } from "../util/error"
import { evalError, stepFailed } from "./error"
import type { RenderContext, StepBinding } from "./render"
import type { FrontierNode } from "./schema"
import { callEnv, findCallTarget, parseCallInputs } from "./call"
import { createFrontierNode, planBlockFrontier, planParallelFrontier } from "./frontier"

export type PlannerScope = {
  activeWorkflowIds: string[]
  env: Record<string, string | undefined>
  frameId: FrameId
  inputs: Record<string, unknown>
  run: Record<string, unknown>
  steps: Record<string, StepBinding>
}

export type BranchSelection = {
  caseNode: BranchCase
  index: number
}

export type PreparedStep =
  | {
      env: Record<string, string | undefined>
      frontier: FrontierNode[]
      kind: "action"
      step: ActionNode
    }
  | {
      env: Record<string, string | undefined>
      frontier: []
      kind: "branch"
      selection: BranchSelection | null
      step: BranchNode
    }
  | {
      env: Record<string, string | undefined>
      frontier: []
      kind: "group"
      step: GroupNode
    }
  | {
      env: Record<string, string | undefined>
      kind: "loop"
      frontier: []
      step: LoopNode
    }
  | {
      env: Record<string, string | undefined>
      frontier: FrontierNode[]
      inputs: Record<string, unknown>
      kind: "workflow"
      step: WorkflowNode
      workflow?: WorkflowDocument | undefined
    }
  | {
      branchReleasedFrontierNodePaths: NodePath[][]
      env: Record<string, string | undefined>
      frontier: FrontierNode[]
      kind: "parallel"
      step: ParallelNode
    }
  | {
      frontier: []
      kind: "skipped"
      step: WorkflowStep
    }

export function prepareStep(
  step: WorkflowStep,
  nodePath: NodePath,
  scope: PlannerScope,
  cwd: string,
  project?: WorkflowProject,
): PreparedStep {
  const preparedContext = prepareStepContext(scope, step)
  if (preparedContext.kind === "skipped") {
    return { frontier: [], kind: "skipped", step }
  }

  const { context, env } = preparedContext

  switch (step.type) {
    case "shell":
    case "codex":
    case "cursor":
    case "write_file":
      return {
        env,
        frontier: [createFrontierNode(step, nodePath, scope.frameId, context, cwd)],
        kind: "action",
        step,
      }
    case "group":
      return {
        env,
        frontier: [],
        kind: "group",
        step,
      }
    case "loop":
      return {
        env,
        frontier: [],
        kind: "loop",
        step,
      }
    case "workflow": {
      const inputs = renderWorkflowInputs(step.with.inputs ?? {}, context)
      const workflow = findCallTarget({
        activeWorkflowIds: scope.activeWorkflowIds,
        nodePath,
        project,
        step,
      })
      const normalizedInputs =
        workflow === undefined ? undefined : parseCallInputs({ inputs, nodePath, step, workflow })
      const frontier =
        workflow === undefined || normalizedInputs === undefined
          ? []
          : planBlockFrontier(
              workflow.steps,
              nodePath,
              {
                activeWorkflowIds: [...scope.activeWorkflowIds, workflow.id],
                frameId: callFrame(scope.frameId, nodePath),
              },
              createRenderContext(callEnv(env, workflow, normalizedInputs), normalizedInputs, {}, {}),
              cwd,
              project,
            )
      return {
        env,
        frontier,
        inputs,
        kind: "workflow",
        step,
        workflow,
      }
    }
    case "branch":
      return {
        env,
        frontier: [],
        kind: "branch",
        selection: selectBranchCase(step, context) ?? null,
        step,
      }
    case "parallel": {
      const frontierPlans = planParallelFrontier(
        step,
        nodePath,
        {
          activeWorkflowIds: scope.activeWorkflowIds,
          frameId: scope.frameId,
        },
        context,
        cwd,
        project,
      )
      return {
        branchReleasedFrontierNodePaths: frontierPlans.map((plan) => plan.nodes.map((node) => node.node_path)),
        env,
        frontier: frontierPlans.flatMap((plan) => plan.nodes),
        kind: "parallel",
        step,
      }
    }
  }
}

export function evaluateExpression(template: string, context: RenderContext): unknown {
  try {
    return renderTemplate(template, context)
  } catch (error) {
    throw evalError(error)
  }
}

export function renderEnvironment(envMap: Record<string, string>, context: RenderContext): Record<string, string> {
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(envMap)) {
    try {
      entries.push([key, renderString(value, context)])
    } catch (error) {
      throw stepFailed(error)
    }
  }

  return Object.fromEntries(entries)
}

export function renderWorkflowInputs(inputs: Record<string, unknown>, context: RenderContext): Record<string, unknown> {
  const renderedInputs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === "string") {
      try {
        renderedInputs[key] = renderTemplate(value, context)
      } catch (error) {
        throw evalError(error)
      }
      continue
    }

    renderedInputs[key] = value
  }

  return renderedInputs
}

export function prepareStepContext(
  scope: PlannerScope,
  step: WorkflowStep,
): { kind: "skipped" } | { context: RenderContext; env: Record<string, string | undefined>; kind: "ready" } {
  const context = createRenderContext(scope.env, scope.inputs, scope.run, scope.steps)
  if (step.if !== undefined && !Boolean(evaluateExpression(step.if, context))) {
    return { kind: "skipped" }
  }

  const stepEnv = renderEnvironment(step.env ?? {}, context)
  const env = { ...scope.env, ...stepEnv }
  return {
    context: createRenderContext(env, scope.inputs, scope.run, scope.steps),
    env,
    kind: "ready",
  }
}

export function selectBranchCase(step: BranchNode, context: RenderContext): BranchSelection | undefined {
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

export function createRenderContext(
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

export function renderStringSafely(template: string, context: RenderContext): string {
  try {
    return renderString(template, context)
  } catch (error) {
    const message = normalizeError(error).message
    if (message.length === 0) {
      return `${template} (preview unavailable)`
    }

    return `${template} (preview unavailable: ${message})`
  }
}
