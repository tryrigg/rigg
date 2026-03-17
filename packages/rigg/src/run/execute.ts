import { renderTemplate } from "../compile/expr"
import { onAbort } from "../util/abort"
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
import { v7 as uuidv7 } from "uuid"
import { runActionStep, type ActionStepOutput } from "./action"
import { createControlBroker, resolveInteraction, waitForBarrier, type ControlBroker } from "./control"
import {
  LoopExhaustedError,
  StepInterruptedError,
  createEvaluationError,
  isStepInterrupted,
  normalizeExecutionError,
} from "./error"
import {
  createNodeSnapshot,
  currentNodeSnapshot,
  finishNode,
  finishThrownControlNode,
  markCaseSkipped,
  recordSkippedStep,
  setNodeProgress,
  startNode,
  startSyntheticNode,
  statusForBinding,
  summarizeCompletedNode,
  type NodeLifecycle,
} from "./node"
import { evaluateExpression, prepareStep, renderEnvironment, type PreparedStep } from "./plan"
import type { RunControlHandler, RunEvent } from "./progress"
import { snapshotRunEvent } from "./snapshot"
import type { BarrierReason, CompletedNodeSummary, RunReason, RunSnapshot } from "./schema"
import type { RenderContext, StepBinding } from "./render"
import { createInitialRunState, setRunFinished } from "./state"
import { elapsedMs, timestampNow } from "../util/time"

type ActionStepRunner = typeof runActionStep
type ExecutionDisposition = "completed" | "failed" | "interrupted"
type ControlNode = BranchNode | GroupNode | LoopNode | ParallelNode

type ExecutionResult = {
  barrierContext: BarrierContext
  bindings: Record<string, StepBinding>
  disposition: ExecutionDisposition
  reason: RunReason | undefined
}

type StepExecutionOutcome = {
  bindingStatus: StepBinding["status"] | null
  completed: CompletedNodeSummary
  disposition: ExecutionDisposition
  reason: RunReason | undefined
  result: unknown
}

type ExecutionEnvironment = {
  controlBroker: ControlBroker
  controlHandler: RunControlHandler
  cwd: string
  emitEvent: (event: RunEvent) => void
  runActionStep: ActionStepRunner
  runState: RunSnapshot
}

type ExecutionScope = {
  barrierMode: "default" | "suppressed"
  barrierContext: BarrierContext
  env: Record<string, string | undefined>
  frameId: FrameId
  inputs: Record<string, unknown>
  releasedFrontierNodePaths: Set<NodePath>
  run: Record<string, unknown>
  signal: AbortSignal | undefined
  steps: Record<string, StepBinding>
}

type BarrierContext = {
  completed: CompletedNodeSummary | null
  reason: BarrierReason
}

export async function executeWorkflow(options: {
  controlHandler: RunControlHandler
  internals?: { runActionStep?: ActionStepRunner } | undefined
  invocationInputs: Record<string, unknown>
  onEvent?: ((event: RunEvent) => void) | undefined
  parentEnv: Record<string, string | undefined>
  projectRoot: string
  signal?: AbortSignal | undefined
  workflow: WorkflowDocument
}): Promise<RunSnapshot> {
  const runId = uuidv7()
  const startedAt = timestampNow()
  const runState = createInitialRunState(runId, options.workflow.id, startedAt)
  const resolvedRunActionStep = options.internals?.runActionStep ?? runActionStep
  const environment: ExecutionEnvironment = {
    controlHandler: options.controlHandler,
    controlBroker: createControlBroker(),
    cwd: options.projectRoot,
    emitEvent: (event) => options.onEvent?.(snapshotRunEvent(event)),
    runActionStep: resolvedRunActionStep,
    runState,
  }

  environment.emitEvent({ kind: "run_started", snapshot: runState })

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
        barrierMode: "default",
        barrierContext: { completed: null, reason: "run_started" },
        env: { ...options.parentEnv, ...workflowEnv },
        frameId: rootFrameId(),
        inputs: options.invocationInputs,
        releasedFrontierNodePaths: new Set(),
        run: {},
        signal: options.signal,
        steps: {},
      },
      options.workflow.steps,
      "",
    )

    const finishedAt = timestampNow()
    const { reason, status } = summarizeRunCompletion(execution)
    setRunFinished(runState, status, reason, finishedAt)
    environment.emitEvent({ kind: "run_finished", snapshot: runState })
    return runState
  } catch (error) {
    if (isStepInterrupted(error)) {
      const finishedAt = timestampNow()
      setRunFinished(runState, "aborted", "aborted", finishedAt)
      environment.emitEvent({ kind: "run_finished", snapshot: runState })
      return runState
    }

    const cause = normalizeExecutionError(error)
    const finishedAt = timestampNow()
    const status = cause.runReason === "aborted" ? "aborted" : "failed"
    setRunFinished(runState, status, cause.runReason, finishedAt)
    environment.emitEvent({ kind: "run_finished", snapshot: runState })
    throw cause
  }
}

async function executeBlock(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  steps: WorkflowStep[],
  pathPrefix: string,
): Promise<ExecutionResult> {
  const localBindings: Record<string, StepBinding> = {}
  let barrierContext = scope.barrierContext

  for (const [index, step] of steps.entries()) {
    throwIfAborted(scope.signal)

    const nodePath = pathPrefix.length === 0 ? rootNodePath(index) : childNodePath(pathPrefix, index)
    const bindings = { ...scope.steps, ...localBindings }
    const prepared = prepareStep(
      step,
      nodePath,
      {
        env: scope.env,
        frameId: scope.frameId,
        inputs: scope.inputs,
        run: scope.run,
        steps: bindings,
      },
      environment.cwd,
    )
    const frontier = prepared.frontier
    if (frontier.length > 0) {
      const frontierReleased = consumeReleasedFrontier(
        scope.releasedFrontierNodePaths,
        frontier.map((node) => node.node_path),
      )
      if (!frontierReleased && scope.barrierMode === "default") {
        try {
          await waitForBarrier(environment, {
            completed: barrierContext.completed,
            frameId: scope.frameId,
            next: frontier,
            reason: barrierContext.reason,
            signal: scope.signal,
          })
        } catch (error) {
          if (isStepInterrupted(error)) {
            return {
              barrierContext,
              bindings: localBindings,
              disposition: "interrupted",
              reason: undefined,
            }
          }
          throw error
        }
      }
    }

    const stepResult = await executePreparedStep(
      environment,
      {
        ...scope,
        barrierContext,
        steps: bindings,
      },
      prepared,
      nodePath,
    )
    barrierContext = nextBarrierContext(stepResult.completed)

    if (step.id !== undefined && stepResult.bindingStatus !== null) {
      localBindings[step.id] = {
        result: stepResult.result,
        status: stepResult.bindingStatus,
      }
    }

    if (stepResult.disposition !== "completed") {
      return {
        barrierContext,
        bindings: localBindings,
        disposition: stepResult.disposition,
        reason: stepResult.reason,
      }
    }
  }

  return { barrierContext, bindings: localBindings, disposition: "completed", reason: undefined }
}

function consumeReleasedFrontier(releasedFrontierNodePaths: Set<NodePath>, frontierNodePaths: NodePath[]): boolean {
  if (frontierNodePaths.length === 0) {
    return false
  }

  for (const nodePath of frontierNodePaths) {
    if (!releasedFrontierNodePaths.has(nodePath)) {
      return false
    }
  }

  for (const nodePath of frontierNodePaths) {
    releasedFrontierNodePaths.delete(nodePath)
  }

  return true
}

async function executePreparedStep(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  prepared: PreparedStep,
  nodePath: NodePath,
): Promise<StepExecutionOutcome> {
  switch (prepared.kind) {
    case "skipped": {
      const snapshot = recordSkippedStep(
        environment.runState,
        prepared.step,
        nodePath,
        "condition evaluated to false",
        environment.emitEvent,
      )
      return {
        bindingStatus: "skipped",
        completed: summarizeCompletedNode(snapshot),
        disposition: "completed",
        reason: undefined,
        result: null,
      }
    }
    case "action":
      return executeAction(environment, scope, prepared.step, prepared.step, nodePath, prepared.env)
    case "group":
      return executeGroup(environment, scope, prepared.step, nodePath, prepared.env)
    case "loop":
      return executeLoop(environment, scope, prepared.step, nodePath, prepared.env)
    case "branch":
      return executeBranch(environment, scope, prepared.step, nodePath, prepared.env, prepared.selection)
    case "parallel":
      return executeParallel(
        environment,
        scope,
        prepared.step,
        nodePath,
        prepared.env,
        prepared.branchReleasedFrontierNodePaths,
      )
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
  throwIfAborted(scope.signal)
  const lifecycle = startNode(environment.runState, originalStep, nodePath, step.type, environment.emitEvent)

  let output: ActionStepOutput
  try {
    output = await environment.runActionStep(
      step,
      { env, inputs: scope.inputs, run: scope.run, steps: scope.steps },
      {
        cwd: environment.cwd,
        env,
        interactionHandler: async (request) =>
          await resolveInteraction(environment, request, { nodePath, userId: step.id ?? null }, scope.signal),
        onOutput: async (stream, chunk) => {
          environment.emitEvent({
            chunk,
            kind: "step_output",
            node_path: nodePath,
            stream,
            user_id: step.id ?? null,
          })
        },
        onProviderEvent: async (event) => {
          environment.emitEvent({
            event,
            kind: "provider_event",
            node_path: nodePath,
            user_id: step.id ?? null,
          })
        },
        signal: scope.signal,
      },
    )
  } catch (error) {
    if (isStepInterrupted(error)) {
      const snapshot = createNodeSnapshot(originalStep.id, nodePath, step.type, "interrupted", lifecycle)
      snapshot.duration_ms = 0
      snapshot.finished_at = timestampNow()
      snapshot.stderr = error.message
      finishNode(environment.runState, snapshot, environment.emitEvent)
      return {
        bindingStatus: null,
        completed: summarizeCompletedNode(snapshot),
        disposition: "interrupted",
        reason: undefined,
        result: null,
      }
    }
    const cause = normalizeExecutionError(error)
    const snapshot = createNodeSnapshot(originalStep.id, nodePath, step.type, "failed", lifecycle)
    snapshot.duration_ms = 0
    snapshot.finished_at = timestampNow()
    snapshot.stderr = cause.message
    finishNode(environment.runState, snapshot, environment.emitEvent)
    throw cause
  }

  const finishedAt = timestampNow()
  const interrupted = output.termination === "interrupted"
  const failed = !interrupted && output.exitCode !== 0
  const snapshot = createNodeSnapshot(
    originalStep.id,
    nodePath,
    step.type,
    interrupted ? "interrupted" : failed ? "failed" : "succeeded",
    lifecycle,
  )
  snapshot.duration_ms = elapsedMs(lifecycle.startedAt, finishedAt)
  snapshot.exit_code = output.exitCode
  snapshot.finished_at = finishedAt
  snapshot.result = interrupted || failed ? null : output.result
  snapshot.stderr = output.stderr.length > 0 ? output.stderr : null
  snapshot.stdout = output.stdout.length > 0 ? output.stdout : null

  finishNode(environment.runState, snapshot, environment.emitEvent)

  return {
    bindingStatus: interrupted ? null : statusForBinding(snapshot.status),
    completed: summarizeCompletedNode(snapshot),
    disposition: interrupted ? "interrupted" : failed ? "failed" : "completed",
    reason: failed ? "step_failed" : undefined,
    result: interrupted || failed ? null : output.result,
  }
}

async function executeGroup(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: GroupNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  return await executeControlNode(environment, step, nodePath, async (lifecycle) => {
    const result = await executeBlock(
      environment,
      {
        ...scope,
        env,
      },
      step.steps,
      nodePath,
    )
    const exports =
      result.disposition !== "completed"
        ? null
        : evaluateExports(step.exports, {
            env,
            inputs: scope.inputs,
            run: scope.run,
            steps: { ...scope.steps, ...result.bindings },
          })
    return finalizeControlStep(environment, step, nodePath, lifecycle, result.disposition, result.reason, exports)
  })
}

async function executeLoop(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: LoopNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  let lastBindings: Record<string, StepBinding> = {}
  const loopScopeId = childLoopScope(scope.frameId, nodePath)
  let iterationBarrierContext = {
    completed: scope.barrierContext.completed,
    reason: "loop_iteration_started",
  } satisfies BarrierContext

  return await executeControlNode(environment, step, nodePath, async (lifecycle) => {
    for (let iteration = 1; iteration <= step.max; iteration += 1) {
      setNodeProgress(environment.runState, nodePath, {
        current_iteration: iteration,
        max_iterations: step.max,
      })
      const iterationFrameId = loopIterationFrameId(loopScopeId, iteration)
      const iterationRun = {
        iteration,
        max_iterations: step.max,
        node_path: nodePath,
      }

      const iterationResult = await executeBlock(
        environment,
        {
          barrierMode: scope.barrierMode,
          barrierContext: iterationBarrierContext,
          env,
          frameId: iterationFrameId,
          inputs: scope.inputs,
          releasedFrontierNodePaths: scope.releasedFrontierNodePaths,
          run: iterationRun,
          signal: scope.signal,
          steps: scope.steps,
        },
        step.steps,
        nodePath,
      )
      lastBindings = iterationResult.bindings
      iterationBarrierContext = {
        completed: iterationResult.barrierContext.completed,
        reason: "loop_iteration_started",
      }
      if (iterationResult.disposition !== "completed") {
        return finalizeControlStep(
          environment,
          step,
          nodePath,
          lifecycle,
          iterationResult.disposition,
          iterationResult.reason,
          null,
        )
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
        return finalizeControlStep(environment, step, nodePath, lifecycle, "completed", undefined, exports)
      }
    }

    throw new LoopExhaustedError(step.id ?? nodePath, step.max)
  })
}

async function executeBranch(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: BranchNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
  selection: { caseNode: BranchCase; index: number } | null,
): Promise<StepExecutionOutcome> {
  return await executeControlNode(environment, step, nodePath, async (lifecycle) => {
    if (selection === null) {
      for (const [index, caseNode] of step.cases.entries()) {
        markCaseSkipped(environment.runState, caseNode, `${nodePath}/${index}`)
      }
      const snapshot = createNodeSnapshot(step.id, nodePath, step.type, "skipped", lifecycle)
      snapshot.duration_ms = 0
      snapshot.finished_at = timestampNow()
      finishNode(environment.runState, snapshot, environment.emitEvent)
      return {
        bindingStatus: "skipped",
        completed: summarizeCompletedNode(snapshot),
        disposition: "completed",
        reason: undefined,
        result: null,
      }
    }

    for (const [index, caseNode] of step.cases.entries()) {
      if (index === selection.index) {
        continue
      }
      markCaseSkipped(environment.runState, caseNode, `${nodePath}/${index}`)
    }

    const casePath = `${nodePath}/${selection.index}`
    const caseLifecycle = startSyntheticNode(environment.runState, casePath, "branch_case", environment.emitEvent)

    try {
      const branchResult = await executeBlock(
        environment,
        {
          ...scope,
          barrierContext: {
            completed: scope.barrierContext.completed,
            reason: "branch_selected",
          },
          env,
        },
        selection.caseNode.steps,
        casePath,
      )
      const exports =
        branchResult.disposition !== "completed"
          ? null
          : evaluateExports(selection.caseNode.exports, {
              env,
              inputs: scope.inputs,
              run: scope.run,
              steps: { ...scope.steps, ...branchResult.bindings },
            })

      const caseFinishedAt = timestampNow()
      const caseSnapshot = createNodeSnapshot(
        undefined,
        casePath,
        "branch_case",
        nodeStatusForDisposition(branchResult.disposition),
        caseLifecycle,
      )
      caseSnapshot.duration_ms = elapsedMs(caseLifecycle.startedAt, caseFinishedAt)
      caseSnapshot.finished_at = caseFinishedAt
      caseSnapshot.result = exports
      finishNode(environment.runState, caseSnapshot, environment.emitEvent)

      return finalizeControlStep(
        environment,
        step,
        nodePath,
        lifecycle,
        branchResult.disposition,
        branchResult.reason,
        exports,
      )
    } catch (error) {
      const interrupted = isStepInterrupted(error)
      const finishedAt = timestampNow()
      const caseSnapshot = createNodeSnapshot(
        undefined,
        casePath,
        "branch_case",
        interrupted ? "interrupted" : "failed",
        caseLifecycle,
      )
      caseSnapshot.duration_ms = elapsedMs(caseLifecycle.startedAt, finishedAt)
      caseSnapshot.finished_at = finishedAt
      caseSnapshot.stderr = interrupted ? error.message : normalizeExecutionError(error).message
      finishNode(environment.runState, caseSnapshot, environment.emitEvent)
      throw error
    }
  })
}

async function executeParallel(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: ParallelNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
  branchReleasedFrontierNodePaths: NodePath[][],
): Promise<StepExecutionOutcome> {
  throwIfAborted(scope.signal)
  return await executeControlNode(environment, step, nodePath, async (lifecycle) => {
    const branchControllers = step.branches.map(() => createAbortController(scope.signal))
    let branchFailure: RunReason | undefined
    let thrownError: Error | undefined

    const branchResults = await Promise.all(
      step.branches.map(async (branch, index) => {
        const branchController = branchControllers[index]
        if (branchController === undefined) {
          throw new Error(`parallel branch controller missing for index ${index}`)
        }

        try {
          const result = await executeBlock(
            environment,
            {
              ...scope,
              barrierMode: "suppressed",
              barrierContext: {
                completed: scope.barrierContext.completed,
                reason: "parallel_frontier",
              },
              env,
              frameId: parallelBranchFrameId(scope.frameId, nodePath, index),
              releasedFrontierNodePaths: new Set(branchReleasedFrontierNodePaths[index] ?? []),
              signal: branchController.controller.signal,
            },
            branch.steps,
            `${nodePath}/${index}`,
          )
          if (result.disposition === "failed") {
            branchFailure ??= result.reason ?? "step_failed"
            abortSiblingBranches(branchControllers, index)
          }
          return {
            kind: "completed" as const,
            result,
          }
        } catch (error) {
          const normalized = normalizeExecutionError(error)
          thrownError ??= normalized
          abortSiblingBranches(branchControllers, index)
          return {
            error: normalized,
            kind: "threw" as const,
          }
        }
      }),
    ).finally(() => {
      for (const controller of branchControllers) {
        controller.dispose()
      }
    })

    const mergedBindings: Record<string, StepBinding> = {}
    let failed = false
    let interrupted = false
    for (const branchResult of branchResults) {
      if (branchResult.kind === "threw") {
        continue
      }

      Object.assign(mergedBindings, branchResult.result.bindings)
      if (branchResult.result.disposition === "failed") {
        failed = true
        branchFailure ??= branchResult.result.reason ?? "step_failed"
      } else if (branchResult.result.disposition === "interrupted") {
        interrupted = true
      }
    }
    if (thrownError !== undefined) {
      throw thrownError
    }

    const resultValue =
      failed || interrupted
        ? null
        : evaluateExports(step.exports, {
            env,
            inputs: scope.inputs,
            run: scope.run,
            steps: { ...scope.steps, ...mergedBindings },
          })
    return finalizeControlStep(
      environment,
      step,
      nodePath,
      lifecycle,
      failed ? "failed" : interrupted ? "interrupted" : "completed",
      branchFailure,
      resultValue,
    )
  })
}

async function executeControlNode(
  environment: ExecutionEnvironment,
  step: ControlNode,
  nodePath: NodePath,
  run: (lifecycle: NodeLifecycle) => Promise<StepExecutionOutcome>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(environment.runState, step, nodePath, step.type, environment.emitEvent)
  try {
    return await run(lifecycle)
  } catch (error) {
    return handleThrownControlStep(environment, step, nodePath, lifecycle, error)
  }
}

function finalizeControlStep(
  environment: ExecutionEnvironment,
  step: ControlNode,
  nodePath: NodePath,
  lifecycle: NodeLifecycle,
  disposition: ExecutionDisposition,
  reason: RunReason | undefined,
  result: unknown,
): StepExecutionOutcome {
  const finishedAt = timestampNow()
  const snapshot = createNodeSnapshot(step.id, nodePath, step.type, nodeStatusForDisposition(disposition), lifecycle)
  snapshot.duration_ms = elapsedMs(lifecycle.startedAt, finishedAt)
  snapshot.finished_at = finishedAt
  snapshot.progress = currentNodeSnapshot(environment.runState, nodePath)?.progress
  snapshot.result = result
  finishNode(environment.runState, snapshot, environment.emitEvent)

  return {
    bindingStatus: disposition === "interrupted" ? null : statusForBinding(snapshot.status),
    completed: summarizeCompletedNode(snapshot),
    disposition,
    reason,
    result,
  }
}

function handleThrownControlStep(
  environment: ExecutionEnvironment,
  step: ControlNode,
  nodePath: NodePath,
  lifecycle: NodeLifecycle,
  error: unknown,
): StepExecutionOutcome {
  const snapshot = finishThrownControlNode(
    environment.runState,
    step,
    nodePath,
    lifecycle,
    error,
    environment.emitEvent,
  )
  if (snapshot.status === "interrupted") {
    return {
      bindingStatus: null,
      completed: summarizeCompletedNode(snapshot),
      disposition: "interrupted",
      reason: undefined,
      result: null,
    }
  }

  throw normalizeExecutionError(error, snapshot.status === "failed" ? "step_failed" : "engine_error")
}

function summarizeRunCompletion(execution: Pick<ExecutionResult, "disposition" | "reason">): {
  reason: RunReason
  status: "aborted" | "failed" | "succeeded"
} {
  switch (execution.disposition) {
    case "completed":
      return { reason: "completed", status: "succeeded" }
    case "failed":
      return { reason: execution.reason ?? "step_failed", status: "failed" }
    case "interrupted":
      return { reason: "aborted", status: "aborted" }
  }
}

function nodeStatusForDisposition(disposition: ExecutionDisposition): "failed" | "interrupted" | "succeeded" {
  switch (disposition) {
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "interrupted":
      return "interrupted"
  }
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

function nextBarrierContext(completed: CompletedNodeSummary): BarrierContext {
  return {
    completed,
    reason: "step_completed",
  }
}

function createAbortController(signal: AbortSignal | undefined): {
  controller: AbortController
  dispose: () => void
} {
  const controller = new AbortController()
  const dispose = onAbort(signal, () => {
    controller.abort(signal?.reason)
  })

  return {
    controller,
    dispose,
  }
}

function abortSiblingBranches(
  controllers: Array<{
    controller: AbortController
    dispose: () => void
  }>,
  excludedIndex: number,
): void {
  for (const [index, entry] of controllers.entries()) {
    if (index === excludedIndex || entry.controller.signal.aborted) {
      continue
    }
    entry.controller.abort(new StepInterruptedError("parallel branch interrupted after sibling failure"))
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new StepInterruptedError("step interrupted", { cause: signal.reason })
  }
}
