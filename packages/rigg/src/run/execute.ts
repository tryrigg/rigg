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
import { v7 as uuidv7 } from "uuid"
import { runActionStep, type ActionStepOutput } from "./adapters"
import { createControlBroker, resolveInteraction, waitForBarrier, type ControlBroker } from "./control"
import {
  LoopExhaustedError,
  StepInterruptedError,
  createEvaluationError,
  createStepFailedError,
  isStepInterrupted,
  normalizeExecutionError,
} from "./error"
import { describeFrontier, describeParallelFrontier, shouldPauseBeforeStep } from "./frontier"
import {
  createNodeSnapshot,
  currentNodeSnapshot,
  finishNode,
  finishThrownControlNode,
  markCaseSkipped,
  recordSkippedStep,
  startNode,
  statusForBinding,
  summarizeCompletedNode,
} from "./node"
import type { RunControlHandler, RunEvent } from "./progress"
import type { BarrierReason, CompletedNodeSummary, RunReason, RunSnapshot } from "./schema"
import type { RenderContext, StepBinding } from "./render"
import { createInitialRunState, setRunFinished } from "./state"

type ActionStepRunner = typeof runActionStep

type ExecutionResult = {
  bindings: Record<string, StepBinding>
  disposition: "completed" | "failed" | "interrupted"
  reason: RunReason | undefined
}

type StepExecutionOutcome = {
  bindingStatus: StepBinding["status"] | null
  completed: CompletedNodeSummary
  disposition: "completed" | "failed" | "interrupted"
  reason: RunReason | undefined
  result: unknown
}

type ExecutionEnvironment = {
  codexSession?: CodexRuntimeSession | undefined
  controlBroker: ControlBroker
  controlHandler?: RunControlHandler | undefined
  cwd: string
  emitEvent: (event: RunEvent) => void
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
  signal: AbortSignal | undefined
  steps: Record<string, StepBinding>
}

export async function executeWorkflow(options: {
  controlHandler?: RunControlHandler | undefined
  internals?: { runActionStep?: ActionStepRunner } | undefined
  invocationInputs: Record<string, unknown>
  onEvent?: ((event: RunEvent) => void) | undefined
  parentEnv: Record<string, string | undefined>
  projectRoot: string
  workflow: WorkflowDocument
}): Promise<RunSnapshot> {
  const runId = uuidv7()
  const startedAt = new Date().toISOString()
  const runState = createInitialRunState(runId, options.workflow.id, startedAt)
  const resolvedRunActionStep = options.internals?.runActionStep ?? runActionStep
  const environment: ExecutionEnvironment = {
    controlHandler: options.controlHandler,
    controlBroker: createControlBroker(),
    cwd: options.projectRoot,
    emitEvent: (event) => options.onEvent?.(event),
    runActionStep: resolvedRunActionStep,
    runState,
  }

  if (resolvedRunActionStep === runActionStep && workflowContainsCodexStep(options.workflow.steps)) {
    environment.codexSession = await createCodexRuntimeSession({
      cwd: options.projectRoot,
      env: options.parentEnv,
    })
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
        env: { ...options.parentEnv, ...workflowEnv },
        frameId: rootFrameId(),
        inputs: options.invocationInputs,
        iterationFrameId: rootFrameId(),
        loopScopeId: undefined,
        run: {},
        signal: undefined,
        steps: {},
      },
      options.workflow.steps,
      "",
      "run_started",
    )

    const finishedAt = new Date().toISOString()
    const status =
      execution.disposition === "failed" ? "failed" : execution.disposition === "interrupted" ? "aborted" : "succeeded"
    const reason =
      execution.disposition === "failed"
        ? (execution.reason ?? "step_failed")
        : execution.disposition === "interrupted"
          ? "aborted"
          : "completed"
    setRunFinished(runState, status, reason, finishedAt)
    environment.emitEvent({ kind: "run_finished", snapshot: runState })
    return runState
  } catch (error) {
    const cause = normalizeExecutionError(error)
    const finishedAt = new Date().toISOString()
    const status = cause.runReason === "aborted" ? "aborted" : "failed"
    setRunFinished(runState, status, cause.runReason, finishedAt)
    environment.emitEvent({ kind: "run_finished", snapshot: runState })
    throw cause
  } finally {
    await environment.codexSession?.close()
  }
}

async function executeBlock(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  steps: WorkflowStep[],
  pathPrefix: string,
  initialBarrierReason: BarrierReason,
): Promise<ExecutionResult> {
  const localBindings: Record<string, StepBinding> = {}
  let previousCompleted: CompletedNodeSummary | null = null
  let barrierReason = initialBarrierReason

  for (const [index, step] of steps.entries()) {
    throwIfAborted(scope.signal)

    const nodePath = pathPrefix.length === 0 ? rootNodePath(index) : childNodePath(pathPrefix, index)
    const bindings = { ...scope.steps, ...localBindings }
    const renderContext: RenderContext = {
      env: scope.env,
      inputs: scope.inputs,
      run: scope.run,
      steps: bindings,
    }

    if (shouldPauseBeforeStep(step)) {
      const frontier = describeFrontier(step, nodePath, scope.frameId, renderContext, environment.cwd)
      if (frontier.length > 0) {
        await waitForBarrier(environment, {
          completed: previousCompleted,
          frameId: scope.frameId,
          next: frontier,
          reason: previousCompleted === null ? barrierReason : "step_completed",
        })
      }
      previousCompleted = null
      barrierReason = "step_completed"
    }

    const stepResult = await executeStep(
      environment,
      {
        ...scope,
        steps: bindings,
      },
      step,
      nodePath,
    )
    previousCompleted = stepResult.completed

    if (step.id !== undefined && stepResult.bindingStatus !== null) {
      localBindings[step.id] = {
        result: stepResult.result,
        status: stepResult.bindingStatus,
      }
    }

    if (stepResult.disposition !== "completed") {
      return {
        bindings: localBindings,
        disposition: stepResult.disposition,
        reason: stepResult.reason,
      }
    }
  }

  return { bindings: localBindings, disposition: "completed", reason: undefined }
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
      const snapshot = recordSkippedStep(
        environment.runState,
        step,
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
  throwIfAborted(scope.signal)
  const lifecycle = startNode(environment.runState, originalStep, nodePath, step.type, environment.emitEvent)

  let output: ActionStepOutput
  try {
    output = await environment.runActionStep(
      step,
      { env, inputs: scope.inputs, run: scope.run, steps: scope.steps },
      {
        codexSession: environment.codexSession,
        cwd: environment.cwd,
        env,
        interactionHandler: async (request) =>
          await resolveInteraction(environment, request, { nodePath, userId: step.id ?? null }),
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
      snapshot.finished_at = new Date().toISOString()
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
    snapshot.finished_at = new Date().toISOString()
    snapshot.stderr = cause.message
    finishNode(environment.runState, snapshot, environment.emitEvent)
    throw cause
  }

  const finishedAt = new Date().toISOString()
  const interrupted = output.termination === "interrupted"
  const failed = !interrupted && output.exitCode !== 0
  const snapshot = createNodeSnapshot(
    originalStep.id,
    nodePath,
    step.type,
    interrupted ? "interrupted" : failed ? "failed" : "succeeded",
    lifecycle,
  )
  snapshot.duration_ms = Date.parse(finishedAt) - Date.parse(lifecycle.startedAt)
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
  const lifecycle = startNode(environment.runState, step, nodePath, step.type, environment.emitEvent)
  try {
    const result = await executeBlock(environment, { ...scope, env }, step.steps, nodePath, "run_started")
    const exports =
      result.disposition !== "completed"
        ? null
        : evaluateExports(step.exports, {
            env,
            inputs: scope.inputs,
            run: scope.run,
            steps: { ...scope.steps, ...result.bindings },
          })

    const snapshot = createNodeSnapshot(
      step.id,
      nodePath,
      step.type,
      result.disposition === "failed" ? "failed" : result.disposition === "interrupted" ? "interrupted" : "succeeded",
      lifecycle,
    )
    snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
    snapshot.finished_at = new Date().toISOString()
    snapshot.result = exports
    finishNode(environment.runState, snapshot, environment.emitEvent)

    return {
      bindingStatus: result.disposition === "interrupted" ? null : statusForBinding(snapshot.status),
      completed: summarizeCompletedNode(snapshot),
      disposition: result.disposition,
      reason: result.reason,
      result: exports,
    }
  } catch (error) {
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
}

async function executeLoop(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: LoopNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(environment.runState, step, nodePath, step.type, environment.emitEvent)
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

      const iterationResult = await executeBlock(
        environment,
        {
          env,
          frameId: iterationFrameId,
          inputs: scope.inputs,
          iterationFrameId,
          loopScopeId,
          run: iterationRun,
          signal: scope.signal,
          steps: scope.steps,
        },
        step.steps,
        nodePath,
        "loop_iteration_started",
      )
      lastBindings = iterationResult.bindings
      if (iterationResult.disposition !== "completed") {
        const snapshot = createNodeSnapshot(
          step.id,
          nodePath,
          step.type,
          iterationResult.disposition === "interrupted" ? "interrupted" : "failed",
          lifecycle,
        )
        snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
        snapshot.finished_at = new Date().toISOString()
        finishNode(environment.runState, snapshot, environment.emitEvent)
        return {
          bindingStatus: iterationResult.disposition === "interrupted" ? null : "failed",
          completed: summarizeCompletedNode(snapshot),
          disposition: iterationResult.disposition,
          reason: iterationResult.reason,
          result: null,
        }
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
        const snapshot = createNodeSnapshot(step.id, nodePath, step.type, "succeeded", lifecycle)
        snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
        snapshot.finished_at = new Date().toISOString()
        snapshot.result = exports
        finishNode(environment.runState, snapshot, environment.emitEvent)
        return {
          bindingStatus: "succeeded",
          completed: summarizeCompletedNode(snapshot),
          disposition: "completed",
          reason: undefined,
          result: exports,
        }
      }
    }

    throw new LoopExhaustedError(step.id ?? nodePath, step.max)
  } catch (error) {
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
}

async function executeBranch(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: BranchNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  const lifecycle = startNode(environment.runState, step, nodePath, step.type, environment.emitEvent)

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
      const snapshot = createNodeSnapshot(step.id, nodePath, step.type, "skipped", lifecycle)
      snapshot.duration_ms = 0
      snapshot.finished_at = new Date().toISOString()
      finishNode(environment.runState, snapshot, environment.emitEvent)
      return {
        bindingStatus: "skipped",
        completed: summarizeCompletedNode(snapshot),
        disposition: "completed",
        reason: undefined,
        result: null,
      }
    }

    const selectedIndex = step.cases.indexOf(selectedCase)
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
      "branch_selected",
    )
    const exports =
      branchResult.disposition !== "completed"
        ? null
        : evaluateExports(selectedCase.exports, {
            env,
            inputs: scope.inputs,
            run: scope.run,
            steps: { ...scope.steps, ...branchResult.bindings },
          })

    const snapshot = createNodeSnapshot(
      step.id,
      nodePath,
      step.type,
      branchResult.disposition === "failed"
        ? "failed"
        : branchResult.disposition === "interrupted"
          ? "interrupted"
          : "succeeded",
      lifecycle,
    )
    snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
    snapshot.finished_at = new Date().toISOString()
    snapshot.result = exports
    finishNode(environment.runState, snapshot, environment.emitEvent)
    return {
      bindingStatus: branchResult.disposition === "interrupted" ? null : statusForBinding(snapshot.status),
      completed: summarizeCompletedNode(snapshot),
      disposition: branchResult.disposition,
      reason: branchResult.reason,
      result: exports,
    }
  } catch (error) {
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
}

async function executeParallel(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: ParallelNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  throwIfAborted(scope.signal)
  const lifecycle = startNode(environment.runState, step, nodePath, step.type, environment.emitEvent)

  try {
    const frontier = describeParallelFrontier(
      step,
      nodePath,
      scope.frameId,
      {
        env,
        inputs: scope.inputs,
        run: scope.run,
        steps: scope.steps,
      },
      environment.cwd,
    )
    if (frontier.length > 0) {
      await waitForBarrier(environment, {
        completed: summarizeCompletedNode(
          currentNodeSnapshot(environment.runState, nodePath) ??
            createNodeSnapshot(step.id, nodePath, step.type, "running", lifecycle),
        ),
        frameId: scope.frameId,
        next: frontier,
        reason: "parallel_frontier",
      })
    }

    const branchControllers = step.branches.map(() => createAbortController(scope.signal))
    let branchFailure: RunReason | undefined
    let thrownError: Error | undefined

    const branchResults = await Promise.all(
      step.branches.map(async (branch, index) => {
        try {
          const result = await executeBlock(
            environment,
            {
              ...scope,
              env,
              frameId: parallelBranchFrameId(scope.frameId, nodePath, index),
              signal: branchControllers[index]!.controller.signal,
            },
            branch.steps,
            `${nodePath}/${index}`,
            "parallel_frontier",
          )
          if (result.disposition === "failed") {
            branchFailure ??= result.reason ?? "step_failed"
            abortSiblingBranches(branchControllers, index)
          }
          return {
            error: undefined,
            result,
          }
        } catch (error) {
          const normalized = normalizeExecutionError(error)
          thrownError ??= normalized
          abortSiblingBranches(branchControllers, index)
          return {
            error: normalized,
            result: undefined,
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
      if (branchResult.result !== undefined) {
        Object.assign(mergedBindings, branchResult.result.bindings)
        if (branchResult.result.disposition === "failed") {
          failed = true
          branchFailure ??= branchResult.result.reason ?? "step_failed"
        } else if (branchResult.result.disposition === "interrupted") {
          interrupted = true
        }
        continue
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

    const snapshot = createNodeSnapshot(
      step.id,
      nodePath,
      step.type,
      failed ? "failed" : interrupted ? "interrupted" : "succeeded",
      lifecycle,
    )
    snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
    snapshot.finished_at = new Date().toISOString()
    snapshot.result = resultValue
    finishNode(environment.runState, snapshot, environment.emitEvent)
    return {
      bindingStatus: interrupted ? null : statusForBinding(snapshot.status),
      completed: summarizeCompletedNode(snapshot),
      disposition: failed ? "failed" : interrupted ? "interrupted" : "completed",
      reason: branchFailure,
      result: resultValue,
    }
  } catch (error) {
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

function createAbortController(signal: AbortSignal | undefined): {
  controller: AbortController
  dispose: () => void
} {
  const controller = new AbortController()
  const abortListener = () => {
    controller.abort(signal?.reason)
  }

  if (signal?.aborted) {
    abortListener()
  } else {
    signal?.addEventListener("abort", abortListener, { once: true })
  }

  return {
    controller,
    dispose: () => signal?.removeEventListener("abort", abortListener),
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
