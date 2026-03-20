import { renderTemplate, renderTemplateString } from "../compile/expr"
import {
  childWorkflowFrameId,
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
  type WorkflowDocument,
  type WorkflowNode,
  type WorkflowStep,
} from "../compile/schema"
import type { WorkflowProject } from "../compile/project"
import { workflowById } from "../compile/project"
import { normalizeError } from "../util/error"
import { RunExecutionError, createEvaluationError, createStepFailedError } from "./error"
import { normalizeInvocationInputs } from "./invocation"
import { preview } from "./node"
import type { RenderContext, StepBinding } from "./render"
import type { FrontierNode } from "./schema"

type PlannerScope = {
  activeWorkflowIds: string[]
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
    case "write_file":
      return {
        env,
        frontier: [
          createFrontierNode(
            step,
            nodePath,
            scope.frameId,
            context.env,
            context.inputs,
            context.run,
            context.steps,
            cwd,
          ),
        ],
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
      const workflow = project === undefined ? undefined : workflowById(project, step.with.workflow)
      if (workflow !== undefined && scope.activeWorkflowIds.includes(workflow.id)) {
        throw new RunExecutionError(
          `Step \`${step.id ?? nodePath}\` creates a circular workflow reference: ${[
            ...scope.activeWorkflowIds,
            workflow.id,
          ].join(" -> ")}.`,
          {
            runReason: "validation_error",
          },
        )
      }
      const normalizedInputs =
        workflow === undefined ? undefined : normalizeWorkflowCallInputs(workflow, inputs, step, nodePath)
      const frontier =
        workflow === undefined || normalizedInputs === undefined
          ? []
          : planBlockFrontier(
              workflow.steps,
              nodePath,
              {
                activeWorkflowIds: [...scope.activeWorkflowIds, workflow.id],
                frameId: childWorkflowFrameId(scope.frameId, nodePath),
              },
              createRenderContext(
                {
                  ...env,
                  ...renderEnvironment(workflow.env ?? {}, {
                    env,
                    inputs: normalizedInputs,
                    run: {},
                    steps: {},
                  }),
                },
                normalizedInputs,
                {},
                {},
              ),
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

export function frontierForPreparedStep(
  prepared: PreparedStep,
  nodePath: NodePath,
  scope: PlannerScope,
  cwd: string,
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
  scope: Pick<PlannerScope, "activeWorkflowIds" | "frameId">,
  context: RenderContext,
  cwd: string,
  project?: WorkflowProject,
): ExecutableFrontierPlan[] {
  return step.branches.map((branch, index) => {
    const branchFrameId = parallelBranchFrameId(scope.frameId, nodePath, index)
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

function planBlockFrontier(
  steps: WorkflowStep[],
  pathPrefix: NodePath,
  scope: Pick<PlannerScope, "activeWorkflowIds" | "frameId">,
  context: RenderContext,
  cwd: string,
  project?: WorkflowProject,
  detailOverride?: string,
): FrontierNode[] {
  for (const [index, step] of steps.entries()) {
    const frontier = planStepFrontier(
      step,
      childNodePath(pathPrefix, index),
      scope,
      context,
      cwd,
      project,
      detailOverride,
    )
    if (frontier.length > 0) {
      return frontier
    }
  }

  return []
}

function planStepFrontier(
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
      if (detailOverride === undefined) {
        return prepared.frontier
      }
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
      const iterationFrameId = loopIterationFrameId(childLoopScope(scope.frameId, nodePath), 1)
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

      if (scope.activeWorkflowIds.includes(prepared.workflow.id)) {
        throw new RunExecutionError(
          `Step \`${prepared.step.id ?? nodePath}\` creates a circular workflow reference: ${[
            ...scope.activeWorkflowIds,
            prepared.workflow.id,
          ].join(" -> ")}.`,
          {
            runReason: "validation_error",
          },
        )
      }

      const normalizedInputs = normalizeWorkflowCallInputs(prepared.workflow, prepared.inputs, prepared.step, nodePath)

      const childEnv = {
        ...prepared.env,
        ...renderEnvironment(prepared.workflow.env ?? {}, {
          env: prepared.env,
          inputs: normalizedInputs,
          run: {},
          steps: {},
        }),
      }

      return planBlockFrontier(
        prepared.workflow.steps,
        nodePath,
        {
          activeWorkflowIds: [...scope.activeWorkflowIds, prepared.workflow.id],
          frameId: childWorkflowFrameId(scope.frameId, nodePath),
        },
        createRenderContext(childEnv, normalizedInputs, {}, {}),
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
    case "parallel":
      return detailOverride === undefined
        ? prepared.frontier
        : planParallelFrontier(
            prepared.step,
            nodePath,
            {
              activeWorkflowIds: scope.activeWorkflowIds,
              frameId: scope.frameId,
            },
            createRenderContext(prepared.env, context.inputs, context.run, context.steps),
            cwd,
            project,
          ).flatMap((plan) => plan.nodes)
  }
}

function renderWorkflowInputs(inputs: Record<string, unknown>, context: RenderContext): Record<string, unknown> {
  const renderedInputs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === "string") {
      try {
        renderedInputs[key] = renderTemplate(value, context)
      } catch (error) {
        throw createEvaluationError(error)
      }
      continue
    }

    renderedInputs[key] = value
  }

  return renderedInputs
}

function normalizeWorkflowCallInputs(
  workflow: WorkflowDocument,
  inputs: Record<string, unknown>,
  step: WorkflowNode,
  nodePath: NodePath,
): Record<string, unknown> {
  const normalized = normalizeInvocationInputs(workflow, inputs)
  if (normalized.kind === "invalid") {
    throw new RunExecutionError(
      `Step \`${step.id ?? nodePath}\` cannot invoke workflow \`${workflow.id}\`: ${normalized.errors.join("; ")}`,
      {
        runReason: "validation_error",
      },
    )
  }
  return normalized.inputs
}

function prepareStepContext(
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

  if (step.with.action === "review") {
    return "codex review"
  }
  if (step.with.action === "plan") {
    return "codex plan"
  }

  return "codex run"
}

function frontierPromptPreview(step: ActionNode, context: RenderContext): string | null {
  if (step.type === "codex" && step.with.action !== "review") {
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
