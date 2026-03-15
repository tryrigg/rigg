import { renderTemplate, renderTemplateString } from "../compile/expr"
import { createCodexRuntimeSession, type CodexRuntimeSession } from "../codex/runtime"
import {
  childLoopScope,
  childNodePath,
  loopIterationFrameId,
  parallelBranchFrameId,
  rootFrameId,
  rootNodePath,
  type ActionNode,
  type BranchCase,
  type BranchNode,
  type FrameId,
  type GroupNode,
  type LoopNode,
  type NodePath,
  type ParallelNode,
  type WorkflowDocument,
  type WorkflowStep,
} from "../compile/schema"
import type { CodexInteractionHandler } from "../codex/types"
import { v7 as uuidv7 } from "uuid"
import { runActionStep, type ActionStepOutput, type ProviderEvent as ActionProviderEvent } from "./adapters"
import { LoopExhaustedError, createEvaluationError, createStepFailedError, normalizeExecutionError } from "./error"
import type { RunProgressEvent } from "./progress"
import type { RenderContext, StepBinding } from "./render"
import type { NodeSnapshot, RunReason, RunSnapshot } from "./schema"
import { createInitialRunState, nextNodeAttempt, setRunFinished, upsertNodeSnapshot } from "./state"

type ActionStepRunner = typeof runActionStep

type ExecutionResult = {
  bindings: Record<string, StepBinding>
  failed: boolean
  reason: RunReason | undefined
}

type StepExecutionOutcome = {
  failed: boolean
  reason: RunReason | undefined
  result: unknown
  status: StepBinding["status"]
}

type NodeLifecycle = {
  attempt: number
  startedAt: string
}

type ExecutionEnvironment = {
  codexSession?: CodexRuntimeSession | undefined
  cwd: string
  interactionHandler?: CodexInteractionHandler | undefined
  onProgress?: ((event: RunProgressEvent) => void) | undefined
  runActionStep: ActionStepRunner
  runState: RunSnapshot
}

type ExecutionScope = {
  env: Record<string, string | undefined>
  frameId: FrameId
  inputs: Record<string, unknown>
  iterationFrameId: FrameId
  loopScopeId: string | undefined
  run: Record<string, unknown>
  steps: Record<string, StepBinding>
}

export async function executeWorkflow(options: {
  interactionHandler?: CodexInteractionHandler | undefined
  internals?: { runActionStep?: ActionStepRunner } | undefined
  invocationInputs: Record<string, unknown>
  onProgress?: ((event: RunProgressEvent) => void) | undefined
  parentEnv: Record<string, string | undefined>
  projectRoot: string
  workflow: WorkflowDocument
}): Promise<RunSnapshot> {
  const runId = uuidv7()
  const startedAt = new Date().toISOString()

  const runState = createInitialRunState(runId, options.workflow.id, startedAt)
  const nodeCount = countNodes(options.workflow.steps)
  const resolvedRunActionStep = options.internals?.runActionStep ?? runActionStep
  const codexSession =
    resolvedRunActionStep === runActionStep && workflowContainsCodexStep(options.workflow.steps)
      ? await createCodexRuntimeSession({
          cwd: options.projectRoot,
          env: options.parentEnv,
          interactionHandler: options.interactionHandler,
        })
      : undefined
  const environment: ExecutionEnvironment = {
    codexSession,
    cwd: options.projectRoot,
    interactionHandler: options.interactionHandler,
    onProgress: options.onProgress,
    runActionStep: resolvedRunActionStep,
    runState,
  }

  emitProgress(environment.onProgress, {
    kind: "run_started",
    node_count: nodeCount,
    run_id: runId,
    workflow_id: options.workflow.id,
  })

  try {
    const workflowEnv = renderEnvironment(options.workflow.env ?? {}, {
      env: options.parentEnv,
      inputs: options.invocationInputs,
      run: {},
      steps: {},
    })
    const execution = await executeBlock(
      environment,
      {
        env: { ...options.parentEnv, ...workflowEnv },
        frameId: rootFrameId(),
        inputs: options.invocationInputs,
        iterationFrameId: rootFrameId(),
        loopScopeId: undefined,
        run: {},
        steps: {},
      },
      options.workflow.steps,
      "",
    )

    const finishedAt = new Date().toISOString()
    const status = execution.failed ? "failed" : "succeeded"
    const reason = execution.failed ? (execution.reason ?? "step_failed") : "completed"
    setRunFinished(runState, status, reason, finishedAt)
    emitProgress(environment.onProgress, {
      kind: "run_finished",
      reason,
      status,
    })
    return runState
  } catch (error) {
    const cause = normalizeExecutionError(error)
    const finishedAt = new Date().toISOString()
    setRunFinished(runState, "failed", cause.runReason, finishedAt)
    emitProgress(environment.onProgress, {
      kind: "run_finished",
      reason: cause.runReason,
      status: "failed",
    })
    throw cause
  } finally {
    await codexSession?.close()
  }
}

async function executeBlock(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  steps: WorkflowStep[],
  pathPrefix: string,
): Promise<ExecutionResult> {
  const localBindings: Record<string, StepBinding> = {}

  for (const [index, step] of steps.entries()) {
    const nodePath = pathPrefix.length === 0 ? rootNodePath(index) : childNodePath(pathPrefix, index)
    const bindings = { ...scope.steps, ...localBindings }
    const stepResult = await executeStep(
      environment,
      {
        ...scope,
        steps: bindings,
      },
      step,
      nodePath,
    )
    if (step.id !== undefined) {
      localBindings[step.id] = {
        result: stepResult.result,
        status: stepResult.status,
      }
    }

    if (stepResult.failed) {
      return {
        bindings: localBindings,
        failed: true,
        reason: stepResult.reason,
      }
    }
  }

  return { bindings: localBindings, failed: false, reason: undefined }
}

async function executeStep(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: WorkflowStep,
  nodePath: NodePath,
): Promise<StepExecutionOutcome> {
  const renderContext: RenderContext = {
    env: scope.env,
    inputs: scope.inputs,
    run: scope.run,
    steps: scope.steps,
  }

  if (step.if !== undefined) {
    const condition = evaluateExpression(step.if, renderContext)
    if (!condition) {
      recordSkippedStep(
        environment.runState,
        environment.onProgress,
        scope.frameId,
        step,
        nodePath,
        "condition evaluated to false",
      )
      return { failed: false, reason: undefined, result: null, status: "skipped" }
    }
  }

  const stepEnv = renderEnvironment(step.env ?? {}, renderContext)
  const mergedEnv = { ...scope.env, ...stepEnv }

  switch (step.type) {
    case "shell":
    case "codex":
    case "write_file":
      return executeAction(environment, scope, step, step, nodePath, mergedEnv)
    case "group":
      return executeGroup(environment, scope, step, nodePath, mergedEnv)
    case "loop":
      return executeLoop(environment, scope, step, nodePath, mergedEnv)
    case "branch":
      return executeBranch(environment, scope, step, nodePath, mergedEnv)
    case "parallel":
      return executeParallel(environment, scope, step, nodePath, mergedEnv)
  }
}

async function executeAction(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  originalStep: WorkflowStep,
  step: ActionNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(
    environment.runState,
    environment.onProgress,
    scope.frameId,
    originalStep,
    nodePath,
    step.type,
  )

  let output: ActionStepOutput
  try {
    output = await environment.runActionStep(
      step,
      { env, inputs: scope.inputs, run: scope.run, steps: scope.steps },
      {
        codexSession: environment.codexSession,
        cwd: environment.cwd,
        env,
        interactionHandler: environment.interactionHandler,
        onOutput: async (stream, chunk) => {
          emitProgress(environment.onProgress, { chunk, kind: "step_output", stream })
        },
        onProviderEvent: async (event) => {
          emitProviderProgress(environment.onProgress, scope.frameId, step, nodePath, event)
        },
      },
    )
  } catch (error) {
    const cause = normalizeExecutionError(error)
    const snapshot = createNodeSnapshot(originalStep.id, nodePath, "failed", lifecycle)
    snapshot.duration_ms = 0
    snapshot.finished_at = new Date().toISOString()
    snapshot.stderr = cause.message
    snapshot.stderr_preview = cause.message
    finishNode(environment.runState, environment.onProgress, scope.frameId, originalStep, snapshot)
    throw cause
  }

  const finishedAt = new Date().toISOString()
  const failed = output.exitCode !== 0
  const snapshot = createNodeSnapshot(originalStep.id, nodePath, failed ? "failed" : "succeeded", lifecycle)
  snapshot.duration_ms = Date.parse(finishedAt) - Date.parse(lifecycle.startedAt)
  snapshot.exit_code = output.exitCode
  snapshot.finished_at = finishedAt
  snapshot.result = failed ? null : output.result
  snapshot.stderr = output.stderr.length > 0 ? output.stderr : null
  snapshot.stderr_preview = preview(output.stderr)
  snapshot.stdout = output.stdout.length > 0 ? output.stdout : null
  snapshot.stdout_preview = preview(output.stdout)

  finishNode(environment.runState, environment.onProgress, scope.frameId, originalStep, snapshot)

  return {
    failed,
    reason: failed ? "step_failed" : undefined,
    result: failed ? null : output.result,
    status: snapshot.status,
  }
}

async function executeGroup(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: GroupNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(environment.runState, environment.onProgress, scope.frameId, step, nodePath, step.type)
  try {
    const result = await executeBlock(environment, { ...scope, env }, step.steps, nodePath)
    const exports = result.failed
      ? null
      : evaluateExports(step.exports, {
          env,
          inputs: scope.inputs,
          run: scope.run,
          steps: { ...scope.steps, ...result.bindings },
        })

    const snapshot = createNodeSnapshot(step.id, nodePath, result.failed ? "failed" : "succeeded", lifecycle)
    snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
    snapshot.finished_at = new Date().toISOString()
    snapshot.result = exports
    finishNode(environment.runState, environment.onProgress, scope.frameId, step, snapshot)

    return {
      failed: result.failed,
      reason: result.reason,
      result: exports,
      status: snapshot.status,
    }
  } catch (error) {
    finishThrownControlNode(
      environment.runState,
      environment.onProgress,
      scope.frameId,
      step,
      nodePath,
      lifecycle,
      error,
    )
    throw error
  }
}

async function executeLoop(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: LoopNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(environment.runState, environment.onProgress, scope.frameId, step, nodePath, step.type)
  let lastBindings: Record<string, StepBinding> = {}
  const loopScopeId = childLoopScope(scope.frameId, nodePath)

  try {
    for (let iteration = 1; iteration <= step.max; iteration += 1) {
      const iterationFrameId = loopIterationFrameId(loopScopeId, iteration)
      const iterationRun = {
        iteration,
        max_iterations: step.max,
        node_path: nodePath,
      }
      emitProgress(environment.onProgress, {
        frame_id: iterationFrameId,
        iteration,
        kind: "loop_iteration_started",
        max_iterations: step.max,
        node_path: nodePath,
        user_id: step.id ?? null,
      })

      let outcome: "continue" | "completed" | "failed" = "failed"
      let iterationEventRecorded = false
      try {
        const iterationResult = await executeBlock(
          environment,
          {
            env,
            frameId: iterationFrameId,
            inputs: scope.inputs,
            iterationFrameId,
            loopScopeId,
            run: iterationRun,
            steps: scope.steps,
          },
          step.steps,
          nodePath,
        )
        lastBindings = iterationResult.bindings
        if (iterationResult.failed) {
          outcome = "failed"
          recordLoopIterationFinished(
            environment.onProgress,
            iterationFrameId,
            step,
            nodePath,
            iteration,
            step.max,
            outcome,
          )
          iterationEventRecorded = true
          const snapshot = createNodeSnapshot(step.id, nodePath, "failed", lifecycle)
          snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
          snapshot.finished_at = new Date().toISOString()
          finishNode(environment.runState, environment.onProgress, scope.frameId, step, snapshot)
          return { failed: true, reason: iterationResult.reason, result: null, status: "failed" }
        }

        const condition = evaluateExpression(step.until, {
          env,
          inputs: scope.inputs,
          run: iterationRun,
          steps: { ...scope.steps, ...lastBindings },
        })
        if (Boolean(condition)) {
          const exports = evaluateExports(step.exports, {
            env,
            inputs: scope.inputs,
            run: iterationRun,
            steps: { ...scope.steps, ...lastBindings },
          })
          outcome = "completed"
          recordLoopIterationFinished(
            environment.onProgress,
            iterationFrameId,
            step,
            nodePath,
            iteration,
            step.max,
            outcome,
          )
          iterationEventRecorded = true
          const snapshot = createNodeSnapshot(step.id, nodePath, "succeeded", lifecycle)
          snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
          snapshot.finished_at = new Date().toISOString()
          snapshot.result = exports
          finishNode(environment.runState, environment.onProgress, scope.frameId, step, snapshot)
          return { failed: false, reason: undefined, result: exports, status: "succeeded" }
        }

        outcome = "continue"
        recordLoopIterationFinished(
          environment.onProgress,
          iterationFrameId,
          step,
          nodePath,
          iteration,
          step.max,
          outcome,
        )
        iterationEventRecorded = true
      } catch (error) {
        if (!iterationEventRecorded) {
          recordLoopIterationFinished(
            environment.onProgress,
            iterationFrameId,
            step,
            nodePath,
            iteration,
            step.max,
            "failed",
          )
        }
        throw error
      }
    }

    throw new LoopExhaustedError(step.id ?? nodePath, step.max)
  } catch (error) {
    finishThrownControlNode(
      environment.runState,
      environment.onProgress,
      scope.frameId,
      step,
      nodePath,
      lifecycle,
      error,
    )
    throw error
  }
}

async function executeBranch(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: BranchNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(environment.runState, environment.onProgress, scope.frameId, step, nodePath, step.type)

  try {
    let selectedCase: BranchCase | undefined
    for (const caseNode of step.cases) {
      if (caseNode.else === true) {
        if (selectedCase === undefined) {
          selectedCase = caseNode
        }
        continue
      }

      const condition = evaluateExpression(caseNode.if ?? "", {
        env,
        inputs: scope.inputs,
        run: scope.run,
        steps: scope.steps,
      })
      if (Boolean(condition)) {
        selectedCase = caseNode
        break
      }
    }

    if (selectedCase === undefined) {
      const snapshot = createNodeSnapshot(step.id, nodePath, "skipped", lifecycle)
      snapshot.duration_ms = 0
      snapshot.finished_at = new Date().toISOString()
      finishNode(environment.runState, environment.onProgress, scope.frameId, step, snapshot)
      return { failed: false, reason: undefined, result: null, status: "skipped" }
    }

    const selectedIndex = step.cases.indexOf(selectedCase)
    emitProgress(environment.onProgress, {
      case_index: selectedIndex,
      frame_id: scope.frameId,
      kind: "branch_selected",
      node_path: nodePath,
      selection: selectedCase.else === true ? "else" : "if",
      user_id: step.id ?? null,
    })

    for (const [index, caseNode] of step.cases.entries()) {
      if (index === selectedIndex) {
        continue
      }
      markCaseSkipped(environment.runState, caseNode, `${nodePath}/${index}`)
    }

    const branchResult = await executeBlock(
      environment,
      { ...scope, env },
      selectedCase.steps,
      `${nodePath}/${selectedIndex}`,
    )
    const exports = branchResult.failed
      ? null
      : evaluateExports(selectedCase.exports, {
          env,
          inputs: scope.inputs,
          run: scope.run,
          steps: { ...scope.steps, ...branchResult.bindings },
        })

    const snapshot = createNodeSnapshot(step.id, nodePath, branchResult.failed ? "failed" : "succeeded", lifecycle)
    snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
    snapshot.finished_at = new Date().toISOString()
    snapshot.result = exports
    finishNode(environment.runState, environment.onProgress, scope.frameId, step, snapshot)
    return {
      failed: branchResult.failed,
      reason: branchResult.reason,
      result: exports,
      status: snapshot.status,
    }
  } catch (error) {
    finishThrownControlNode(
      environment.runState,
      environment.onProgress,
      scope.frameId,
      step,
      nodePath,
      lifecycle,
      error,
    )
    throw error
  }
}

async function executeParallel(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: ParallelNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(environment.runState, environment.onProgress, scope.frameId, step, nodePath, step.type)

  try {
    const branchResults = await Promise.all(
      step.branches.map(async (branch, index) => {
        try {
          const result = await executeBlock(
            environment,
            {
              ...scope,
              env,
              frameId: parallelBranchFrameId(scope.frameId, nodePath, index),
            },
            branch.steps,
            `${nodePath}/${index}`,
          )
          return {
            error: undefined,
            result,
          }
        } catch (error) {
          return {
            error: normalizeExecutionError(error),
            result: undefined,
          }
        }
      }),
    )

    const mergedBindings: Record<string, StepBinding> = {}
    let failed = false
    let reason: RunReason | undefined
    let thrownError: Error | undefined
    for (const branchResult of branchResults) {
      if (branchResult.result !== undefined) {
        Object.assign(mergedBindings, branchResult.result.bindings)
        if (branchResult.result.failed) {
          failed = true
          reason ??= branchResult.result.reason ?? "step_failed"
        }
      } else {
        thrownError ??= branchResult.error
      }
    }
    if (thrownError !== undefined) {
      throw thrownError
    }

    const resultValue = failed
      ? null
      : evaluateExports(step.exports, {
          env,
          inputs: scope.inputs,
          run: scope.run,
          steps: { ...scope.steps, ...mergedBindings },
        })

    const snapshot = createNodeSnapshot(step.id, nodePath, failed ? "failed" : "succeeded", lifecycle)
    snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
    snapshot.finished_at = new Date().toISOString()
    snapshot.result = resultValue
    finishNode(environment.runState, environment.onProgress, scope.frameId, step, snapshot)
    return { failed, reason, result: resultValue, status: snapshot.status }
  } catch (error) {
    finishThrownControlNode(
      environment.runState,
      environment.onProgress,
      scope.frameId,
      step,
      nodePath,
      lifecycle,
      error,
    )
    throw error
  }
}

function renderEnvironment(envMap: Record<string, string>, context: RenderContext): Record<string, string> {
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

function evaluateExports(exportsMap: Record<string, string> | undefined, context: RenderContext): unknown {
  if (exportsMap === undefined) {
    return null
  }

  const output: Record<string, unknown> = {}
  for (const [key, template] of Object.entries(exportsMap)) {
    try {
      output[key] = renderTemplate(template, context)
    } catch (error) {
      throw createEvaluationError(error)
    }
  }
  return output
}

function evaluateExpression(template: string, context: RenderContext): unknown {
  try {
    return renderTemplate(template, context)
  } catch (error) {
    throw createEvaluationError(error)
  }
}

function emitProgress(onProgress: ((event: RunProgressEvent) => void) | undefined, event: RunProgressEvent): void {
  onProgress?.(event)
}

function countNodes(steps: WorkflowStep[]): number {
  return steps.reduce((count, step) => {
    switch (step.type) {
      case "shell":
      case "codex":
      case "write_file":
        return count + 1
      case "group":
      case "loop":
        return count + 1 + countNodes(step.steps)
      case "branch":
        return count + 1 + step.cases.reduce((sum, branchCase) => sum + countNodes(branchCase.steps), 0)
      case "parallel":
        return count + 1 + step.branches.reduce((sum, branch) => sum + countNodes(branch.steps), 0)
    }
  }, 0)
}

function workflowContainsCodexStep(steps: WorkflowStep[]): boolean {
  return steps.some((step) => {
    switch (step.type) {
      case "codex":
        return true
      case "group":
      case "loop":
        return workflowContainsCodexStep(step.steps)
      case "branch":
        return step.cases.some((branchCase) => workflowContainsCodexStep(branchCase.steps))
      case "parallel":
        return step.branches.some((branch) => workflowContainsCodexStep(branch.steps))
      case "shell":
      case "write_file":
        return false
    }
  })
}

function recordSkippedStep(
  runState: RunSnapshot,
  onProgress: ((event: RunProgressEvent) => void) | undefined,
  frameId: FrameId,
  step: WorkflowStep,
  nodePath: NodePath,
  reason: string,
): void {
  const snapshot = createNodeSnapshot(step.id, nodePath, "skipped", {
    attempt: nextNodeAttempt(runState, nodePath),
    startedAt: new Date().toISOString(),
  })
  snapshot.duration_ms = 0
  snapshot.finished_at = snapshot.started_at
  snapshot.stderr_preview = reason
  upsertNodeSnapshot(runState, snapshot)

  if (step.type === "group" || step.type === "loop") {
    markBlockSkipped(runState, step.steps, nodePath)
  }
  if (step.type === "branch") {
    for (const [index, caseNode] of step.cases.entries()) {
      markCaseSkipped(runState, caseNode, `${nodePath}/${index}`)
    }
  }
  if (step.type === "parallel") {
    for (const [index, branch] of step.branches.entries()) {
      markBlockSkipped(runState, branch.steps, `${nodePath}/${index}`)
    }
  }

  emitProgress(onProgress, {
    frame_id: frameId,
    kind: "node_skipped",
    node_path: nodePath,
    reason,
    user_id: step.id ?? null,
  })
}

function markCaseSkipped(runState: RunSnapshot, caseNode: BranchCase, pathPrefix: string): void {
  markBlockSkipped(runState, caseNode.steps, pathPrefix)
}

function markBlockSkipped(runState: RunSnapshot, steps: WorkflowStep[], pathPrefix: string): void {
  for (const [index, step] of steps.entries()) {
    const nodePath = childNodePath(pathPrefix, index)
    const snapshot = createNodeSnapshot(step.id, nodePath, "skipped", {
      attempt: nextNodeAttempt(runState, nodePath),
      startedAt: new Date().toISOString(),
    })
    snapshot.duration_ms = 0
    snapshot.finished_at = snapshot.started_at
    upsertNodeSnapshot(runState, snapshot)

    if (step.type === "group" || step.type === "loop") {
      markBlockSkipped(runState, step.steps, nodePath)
    }
    if (step.type === "branch") {
      for (const [caseIndex, caseNode] of step.cases.entries()) {
        markCaseSkipped(runState, caseNode, `${nodePath}/${caseIndex}`)
      }
    }
    if (step.type === "parallel") {
      for (const [branchIndex, branch] of step.branches.entries()) {
        markBlockSkipped(runState, branch.steps, `${nodePath}/${branchIndex}`)
      }
    }
  }
}

function startNode(
  runState: RunSnapshot,
  onProgress: ((event: RunProgressEvent) => void) | undefined,
  frameId: FrameId,
  step: WorkflowStep,
  nodePath: NodePath,
  nodeKind: string,
): NodeLifecycle {
  const lifecycle = {
    attempt: nextNodeAttempt(runState, nodePath),
    startedAt: new Date().toISOString(),
  }

  emitProgress(onProgress, {
    attempt: lifecycle.attempt,
    frame_id: frameId,
    kind: "node_started",
    node_kind: nodeKind,
    node_path: nodePath,
    provider: actionProvider(step),
    user_id: step.id ?? null,
  })

  return lifecycle
}

function finishNode(
  runState: RunSnapshot,
  onProgress: ((event: RunProgressEvent) => void) | undefined,
  frameId: FrameId,
  step: WorkflowStep,
  snapshot: NodeSnapshot,
): void {
  upsertNodeSnapshot(runState, snapshot)
  emitProgress(onProgress, {
    duration_ms: snapshot.duration_ms ?? null,
    exit_code: snapshot.exit_code ?? null,
    frame_id: frameId,
    kind: "node_finished",
    node_path: snapshot.node_path,
    status: snapshot.status,
    user_id: step.id ?? null,
  })
}

function finishThrownControlNode(
  runState: RunSnapshot,
  onProgress: ((event: RunProgressEvent) => void) | undefined,
  frameId: FrameId,
  step: WorkflowStep,
  nodePath: NodePath,
  lifecycle: NodeLifecycle,
  error: unknown,
): void {
  const cause = normalizeExecutionError(error)
  const snapshot = createNodeSnapshot(step.id, nodePath, "failed", lifecycle)
  snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
  snapshot.finished_at = new Date().toISOString()
  snapshot.stderr = cause.message
  snapshot.stderr_preview = cause.message
  finishNode(runState, onProgress, frameId, step, snapshot)
}

function recordLoopIterationFinished(
  onProgress: ((event: RunProgressEvent) => void) | undefined,
  frameId: FrameId,
  step: LoopNode,
  nodePath: NodePath,
  iteration: number,
  maxIterations: number,
  outcome: "continue" | "completed" | "failed",
): void {
  emitProgress(onProgress, {
    frame_id: frameId,
    iteration,
    kind: "loop_iteration_finished",
    max_iterations: maxIterations,
    node_path: nodePath,
    outcome,
    user_id: step.id ?? null,
  })
}

function createNodeSnapshot(
  userId: string | undefined,
  nodePath: NodePath,
  status: NodeSnapshot["status"],
  lifecycle: NodeLifecycle,
): NodeSnapshot {
  return {
    attempt: lifecycle.attempt,
    duration_ms: null,
    exit_code: null,
    finished_at: null,
    node_path: nodePath,
    result: null,
    started_at: lifecycle.startedAt,
    status,
    stderr: null,
    stderr_preview: "",
    stdout: null,
    stdout_preview: "",
    user_id: userId ?? null,
  }
}

function preview(value: string): string {
  return value.replaceAll("\n", "\\n").slice(0, 160)
}

function emitProviderProgress(
  onProgress: ((event: RunProgressEvent) => void) | undefined,
  frameId: FrameId,
  step: ActionNode,
  nodePath: NodePath,
  event: ActionProviderEvent,
): void {
  if (event.kind === "tool_use") {
    emitProgress(onProgress, {
      detail: event.detail ?? null,
      frame_id: frameId,
      kind: "provider_tool_use",
      node_path: nodePath,
      provider: event.provider,
      tool: event.tool,
      user_id: step.id ?? null,
    })
    return
  }

  if (event.kind === "status") {
    emitProgress(onProgress, {
      frame_id: frameId,
      kind: "provider_status",
      message: event.message,
      node_path: nodePath,
      provider: event.provider,
      user_id: step.id ?? null,
    })
    return
  }

  emitProgress(onProgress, {
    frame_id: frameId,
    kind: "provider_error",
    message: event.message,
    node_path: nodePath,
    provider: event.provider,
    user_id: step.id ?? null,
  })
}

function actionProvider(step: WorkflowStep): "codex" | null {
  return step.type === "codex" ? "codex" : null
}
