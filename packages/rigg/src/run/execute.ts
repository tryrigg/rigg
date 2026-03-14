import { createHash } from "node:crypto"

import { renderTemplate, renderTemplateString } from "../compile/expr"
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
import type { NodeSnapshot, RunReason, RunSnapshot } from "../history/index"
import { v7 as uuidv7 } from "uuid"
import { runActionStep, type ActionStepOutput, type ProviderEvent as ActionProviderEvent } from "./adapters"
import {
  clearIterationConversations,
  clearLoopConversations,
  cloneConversationStore,
  createConversationStore,
  mergeParallelConversationStore,
  resolveConversation,
  storeConversation,
  syncWorkflowConversations,
  type ConversationStore,
} from "./conversation"
import { LoopExhaustedError, createEvaluationError, createStepFailedError, normalizeExecutionError } from "./error"
import {
  appendNodeLog,
  appendEvent,
  createRunRecorder,
  persistRunSnapshot,
  recorderArtifactsDir,
  writeNodeLog,
  type RunRecorder,
} from "./record"
import type { RecordedRunEventInput, RunProgressEvent } from "./progress"
import type { RenderContext, StepBinding } from "./render"
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
  conversations: ConversationStore
  cwd: string
  onProgress?: ((event: RunProgressEvent) => void) | undefined
  persistConversationSnapshot: boolean
  recorder: RunRecorder
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
  configFiles: string[]
  cwd: string
  internals?: { runActionStep?: ActionStepRunner } | undefined
  invocationInputs: Record<string, unknown>
  onProgress?: ((event: RunProgressEvent) => void) | undefined
  parentEnv: Record<string, string | undefined>
  projectRoot: string
  toolVersion: string
  workflow: WorkflowDocument
}): Promise<RunSnapshot> {
  const runId = uuidv7()
  const startedAt = new Date().toISOString()
  const recorder = await createRunRecorder(options.projectRoot, runId, {
    configFiles: options.configFiles,
    configHash: configHash(options.configFiles, options.workflow),
    cwd: options.projectRoot,
    invocationInputs: options.invocationInputs,
    startedAt,
    toolVersion: options.toolVersion,
    workflowId: options.workflow.id,
  })

  const runState = createInitialRunState(runId, options.workflow.id, startedAt)
  const nodeCount = countNodes(options.workflow.steps)
  const environment: ExecutionEnvironment = {
    conversations: createConversationStore(runState.conversations),
    cwd: options.projectRoot,
    onProgress: options.onProgress,
    persistConversationSnapshot: true,
    recorder,
    runActionStep: options.internals?.runActionStep ?? runActionStep,
    runState,
  }

  await recordEvent(environment, {
    cwd: options.projectRoot,
    kind: "run_started",
    node_count: nodeCount,
    run_id: runId,
    workflow_id: options.workflow.id,
  })
  emitProgress(environment, {
    kind: "run_started",
    node_count: nodeCount,
    run_id: runId,
    workflow_id: options.workflow.id,
  })
  await persistEnvironment(environment)

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
    await recordEvent(environment, {
      kind: "run_finished",
      reason,
      status,
    })
    emitProgress(environment, {
      kind: "run_finished",
      reason,
      status,
    })
    await persistEnvironment(environment)
    return runState
  } catch (error) {
    const cause = normalizeExecutionError(error)
    const finishedAt = new Date().toISOString()
    setRunFinished(runState, "failed", cause.runReason, finishedAt)
    if (cause.emitRunFailed) {
      await recordEvent(environment, {
        kind: "run_failed",
        message: cause.message,
        reason: cause.runReason,
      })
    }
    await recordEvent(environment, {
      kind: "run_finished",
      reason: cause.runReason,
      status: "failed",
    })
    emitProgress(environment, {
      kind: "run_finished",
      reason: cause.runReason,
      status: "failed",
    })
    await persistEnvironment(environment)
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
      await recordSkippedStep(environment, scope, step, nodePath, "condition evaluated to false")
      return { failed: false, reason: undefined, result: null, status: "skipped" }
    }
  }

  const stepEnv = renderEnvironment(step.env ?? {}, renderContext)
  const mergedEnv = { ...scope.env, ...stepEnv }

  switch (step.type) {
    case "shell":
    case "codex":
    case "claude":
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
  const lifecycle = await startNode(environment, scope, originalStep, nodePath, step.type, stepLabel(step))
  const resumeConversationId = resolveConversation(environment.conversations, step, {
    iterationFrameId: scope.iterationFrameId,
    loopScopeId: scope.loopScopeId,
  })?.id

  let stdoutPath: string | undefined
  let stderrPath: string | undefined

  let output: ActionStepOutput
  try {
    output = await environment.runActionStep(
      step,
      { env, inputs: scope.inputs, run: scope.run, steps: scope.steps },
      {
        artifactsDir: recorderArtifactsDir(environment.recorder),
        cwd: environment.cwd,
        env,
        onOutput: async (stream, chunk) => {
          emitProgress(environment, { chunk, kind: "step_output", stream })
          if (stream === "stdout") {
            stdoutPath = await appendNodeLog(
              environment.recorder,
              scope.frameId,
              nodePath,
              lifecycle.attempt,
              "stdout",
              chunk,
            )
          } else {
            stderrPath = await appendNodeLog(
              environment.recorder,
              scope.frameId,
              nodePath,
              lifecycle.attempt,
              "stderr",
              chunk,
            )
          }
        },
        onProviderEvent: async (event) => {
          emitProviderProgress(environment, scope, step, nodePath, event)
        },
        resumeConversationId,
      },
    )
  } catch (error) {
    const cause = normalizeExecutionError(error)
    const snapshot = createNodeSnapshot(originalStep.id, nodePath, "failed", lifecycle)
    snapshot.duration_ms = 0
    snapshot.finished_at = new Date().toISOString()
    snapshot.stderr = cause.message
    snapshot.stderr_preview = cause.message
    snapshot.stdout_path = stdoutPath ?? null
    snapshot.stderr_path = stderrPath ?? null
    await finishNode(environment, scope, originalStep, snapshot)
    throw cause
  }

  stdoutPath ??= await writeNodeLog(
    environment.recorder,
    scope.frameId,
    nodePath,
    lifecycle.attempt,
    "stdout",
    output.stdout,
  )
  stderrPath ??= await writeNodeLog(
    environment.recorder,
    scope.frameId,
    nodePath,
    lifecycle.attempt,
    "stderr",
    output.stderr,
  )
  const providerLogPaths = await appendProviderLogs(
    environment,
    scope,
    step,
    nodePath,
    lifecycle.attempt,
    output.providerEvents,
    output.stdout,
    output.stderr,
  )
  stdoutPath ??= providerLogPaths.stdoutPath
  stderrPath ??= providerLogPaths.stderrPath

  if (hasConversationBinding(step) && output.exitCode === 0 && output.conversation === undefined) {
    const snapshot = createNodeSnapshot(originalStep.id, nodePath, "failed", lifecycle)
    snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
    snapshot.finished_at = new Date().toISOString()
    snapshot.stderr = `\`${step.type}\` did not return a conversation handle for a persisted conversation node`
    snapshot.stderr_preview = snapshot.stderr
    snapshot.stdout_path = stdoutPath ?? null
    snapshot.stderr_path = stderrPath ?? null
    await finishNode(environment, scope, originalStep, snapshot)
    throw createStepFailedError(new Error(snapshot.stderr))
  }

  const finishedAt = new Date().toISOString()
  const failed = output.exitCode !== 0
  const snapshot = createNodeSnapshot(originalStep.id, nodePath, failed ? "failed" : "succeeded", lifecycle)
  snapshot.duration_ms = Date.parse(finishedAt) - Date.parse(lifecycle.startedAt)
  snapshot.exit_code = output.exitCode
  snapshot.finished_at = finishedAt
  snapshot.result = failed ? null : output.result
  snapshot.stderr = output.stderr.length > 0 ? output.stderr : null
  snapshot.stderr_path = stderrPath ?? null
  snapshot.stderr_preview = preview(output.stderr)
  snapshot.stdout = output.stdout.length > 0 ? output.stdout : null
  snapshot.stdout_path = stdoutPath ?? null
  snapshot.stdout_preview = preview(output.stdout)

  if (output.conversation !== undefined) {
    storeConversation(
      environment.conversations,
      step,
      {
        iterationFrameId: scope.iterationFrameId,
        loopScopeId: scope.loopScopeId,
      },
      output.conversation,
    )
  }

  await finishNode(environment, scope, originalStep, snapshot)

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
  const lifecycle = await startNode(environment, scope, step, nodePath, step.type, step.type)
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
    await finishNode(environment, scope, step, snapshot)

    return {
      failed: result.failed,
      reason: result.reason,
      result: exports,
      status: snapshot.status,
    }
  } catch (error) {
    await finishThrownControlNode(environment, scope, step, nodePath, lifecycle, error)
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
  const lifecycle = await startNode(environment, scope, step, nodePath, step.type, step.type)
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
      await recordEvent(environment, {
        frame_id: iterationFrameId,
        iteration,
        kind: "loop_iteration_started",
        max_iterations: step.max,
        node_path: nodePath,
        user_id: step.id ?? null,
      })
      emitProgress(environment, {
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
          await recordLoopIterationFinished(environment, iterationFrameId, step, nodePath, iteration, step.max, outcome)
          iterationEventRecorded = true
          const snapshot = createNodeSnapshot(step.id, nodePath, "failed", lifecycle)
          snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
          snapshot.finished_at = new Date().toISOString()
          await finishNode(environment, scope, step, snapshot)
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
          await recordLoopIterationFinished(environment, iterationFrameId, step, nodePath, iteration, step.max, outcome)
          iterationEventRecorded = true
          const snapshot = createNodeSnapshot(step.id, nodePath, "succeeded", lifecycle)
          snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
          snapshot.finished_at = new Date().toISOString()
          snapshot.result = exports
          await finishNode(environment, scope, step, snapshot)
          return { failed: false, reason: undefined, result: exports, status: "succeeded" }
        }

        outcome = "continue"
        await recordLoopIterationFinished(environment, iterationFrameId, step, nodePath, iteration, step.max, outcome)
        iterationEventRecorded = true
      } catch (error) {
        if (!iterationEventRecorded) {
          await recordLoopIterationFinished(
            environment,
            iterationFrameId,
            step,
            nodePath,
            iteration,
            step.max,
            "failed",
          )
        }
        throw error
      } finally {
        clearIterationConversations(environment.conversations, iterationFrameId)
      }
    }

    throw new LoopExhaustedError(step.id ?? nodePath, step.max)
  } catch (error) {
    await finishThrownControlNode(environment, scope, step, nodePath, lifecycle, error)
    throw error
  } finally {
    clearLoopConversations(environment.conversations, loopScopeId)
  }
}

async function executeBranch(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: BranchNode,
  nodePath: NodePath,
  env: Record<string, string | undefined>,
): Promise<StepExecutionOutcome> {
  const lifecycle = await startNode(environment, scope, step, nodePath, step.type, step.type)

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
      await finishNode(environment, scope, step, snapshot)
      return { failed: false, reason: undefined, result: null, status: "skipped" }
    }

    const selectedIndex = step.cases.indexOf(selectedCase)
    await recordEvent(environment, {
      case_index: selectedIndex,
      frame_id: scope.frameId,
      kind: "branch_selected",
      node_path: nodePath,
      selection: selectedCase.else === true ? "else" : "if",
      user_id: step.id ?? null,
    })
    emitProgress(environment, {
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
      await markCaseSkipped(environment, caseNode, `${nodePath}/${index}`)
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
    await finishNode(environment, scope, step, snapshot)
    return {
      failed: branchResult.failed,
      reason: branchResult.reason,
      result: exports,
      status: snapshot.status,
    }
  } catch (error) {
    await finishThrownControlNode(environment, scope, step, nodePath, lifecycle, error)
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
  const lifecycle = await startNode(environment, scope, step, nodePath, step.type, step.type)
  const baseConversations = cloneConversationStore(environment.conversations)

  try {
    const branchResults = await Promise.all(
      step.branches.map(async (branch, index) => {
        const branchEnvironment: ExecutionEnvironment = {
          ...environment,
          conversations: cloneConversationStore(baseConversations),
          persistConversationSnapshot: false,
        }
        try {
          const result = await executeBlock(
            branchEnvironment,
            {
              ...scope,
              env,
              frameId: parallelBranchFrameId(scope.frameId, nodePath, index),
            },
            branch.steps,
            `${nodePath}/${index}`,
          )
          return {
            conversations: branchEnvironment.conversations,
            error: undefined,
            result,
          }
        } catch (error) {
          return {
            conversations: branchEnvironment.conversations,
            error: normalizeExecutionError(error),
            result: undefined,
          }
        }
      }),
    )

    const mergedBindings: Record<string, StepBinding> = {}
    const mergedConversations = cloneConversationStore(baseConversations)
    let failed = false
    let reason: RunReason | undefined
    let thrownError: Error | undefined
    for (const branchResult of branchResults) {
      if (branchResult.result !== undefined) {
        Object.assign(mergedBindings, branchResult.result.bindings)
        mergeParallelConversationStore(mergedConversations, baseConversations, branchResult.conversations)
        if (branchResult.result.failed) {
          failed = true
          reason ??= branchResult.result.reason ?? "step_failed"
        }
      } else {
        thrownError ??= branchResult.error
      }
    }
    environment.conversations = mergedConversations
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
    await finishNode(environment, scope, step, snapshot)
    return { failed, reason, result: resultValue, status: snapshot.status }
  } catch (error) {
    await finishThrownControlNode(environment, scope, step, nodePath, lifecycle, error)
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

async function recordSkippedStep(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: WorkflowStep,
  nodePath: NodePath,
  reason: string,
): Promise<void> {
  const snapshot = createNodeSnapshot(step.id, nodePath, "skipped", {
    attempt: nextNodeAttempt(environment.runState, nodePath),
    startedAt: new Date().toISOString(),
  })
  snapshot.duration_ms = 0
  snapshot.finished_at = snapshot.started_at
  snapshot.stderr_preview = reason
  upsertNodeSnapshot(environment.runState, snapshot)

  if (step.type === "group" || step.type === "loop") {
    await markBlockSkipped(environment, step.steps, nodePath)
  }
  if (step.type === "branch") {
    for (const [index, caseNode] of step.cases.entries()) {
      await markCaseSkipped(environment, caseNode, `${nodePath}/${index}`)
    }
  }
  if (step.type === "parallel") {
    for (const [index, branch] of step.branches.entries()) {
      await markBlockSkipped(environment, branch.steps, `${nodePath}/${index}`)
    }
  }

  await recordEvent(environment, {
    frame_id: scope.frameId,
    kind: "node_skipped",
    node_path: nodePath,
    reason,
    user_id: step.id ?? null,
  })
  emitProgress(environment, {
    frame_id: scope.frameId,
    kind: "node_skipped",
    node_path: nodePath,
    reason,
    user_id: step.id ?? null,
  })
  await persistEnvironment(environment)
}

async function markCaseSkipped(
  environment: ExecutionEnvironment,
  caseNode: BranchCase,
  pathPrefix: string,
): Promise<void> {
  await markBlockSkipped(environment, caseNode.steps, pathPrefix)
}

async function markBlockSkipped(
  environment: ExecutionEnvironment,
  steps: WorkflowStep[],
  pathPrefix: string,
): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const nodePath = childNodePath(pathPrefix, index)
    const snapshot = createNodeSnapshot(step.id, nodePath, "skipped", {
      attempt: nextNodeAttempt(environment.runState, nodePath),
      startedAt: new Date().toISOString(),
    })
    snapshot.duration_ms = 0
    snapshot.finished_at = snapshot.started_at
    upsertNodeSnapshot(environment.runState, snapshot)
    if (step.type === "group" || step.type === "loop") {
      await markBlockSkipped(environment, step.steps, nodePath)
    }
    if (step.type === "branch") {
      for (const [caseIndex, caseNode] of step.cases.entries()) {
        await markCaseSkipped(environment, caseNode, `${nodePath}/${caseIndex}`)
      }
    }
    if (step.type === "parallel") {
      for (const [branchIndex, branch] of step.branches.entries()) {
        await markBlockSkipped(environment, branch.steps, `${nodePath}/${branchIndex}`)
      }
    }
  }
}

async function startNode(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: WorkflowStep,
  nodePath: NodePath,
  nodeKind: string,
  command: string,
): Promise<NodeLifecycle> {
  const lifecycle = {
    attempt: nextNodeAttempt(environment.runState, nodePath),
    startedAt: new Date().toISOString(),
  }
  await recordEvent(environment, {
    attempt: lifecycle.attempt,
    command,
    frame_id: scope.frameId,
    kind: "node_started",
    node_kind: nodeKind,
    node_path: nodePath,
    provider: actionProvider(step),
    user_id: step.id ?? null,
  })
  emitProgress(environment, {
    attempt: lifecycle.attempt,
    frame_id: scope.frameId,
    kind: "node_started",
    node_kind: nodeKind,
    node_path: nodePath,
    provider: actionProvider(step),
    user_id: step.id ?? null,
  })
  return lifecycle
}

async function finishNode(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: WorkflowStep,
  snapshot: NodeSnapshot,
): Promise<void> {
  upsertNodeSnapshot(environment.runState, snapshot)
  await recordEvent(environment, {
    attempt: snapshot.attempt,
    duration_ms: snapshot.duration_ms ?? null,
    exit_code: snapshot.exit_code ?? null,
    frame_id: scope.frameId,
    kind: "node_finished",
    node_path: snapshot.node_path,
    result: snapshot.result,
    status: snapshot.status,
    stderr: snapshot.stderr ?? null,
    stderr_path: snapshot.stderr_path ?? null,
    stderr_preview: snapshot.stderr_preview,
    stdout: snapshot.stdout,
    stdout_path: snapshot.stdout_path ?? null,
    stdout_preview: snapshot.stdout_preview,
    user_id: step.id ?? null,
  })
  emitProgress(environment, {
    duration_ms: snapshot.duration_ms ?? null,
    exit_code: snapshot.exit_code ?? null,
    frame_id: scope.frameId,
    kind: "node_finished",
    node_path: snapshot.node_path,
    status: snapshot.status,
    stderr_path: snapshot.stderr_path ?? null,
    stdout_path: snapshot.stdout_path ?? null,
    user_id: step.id ?? null,
  })
  await persistEnvironment(environment)
}

async function finishThrownControlNode(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: WorkflowStep,
  nodePath: NodePath,
  lifecycle: NodeLifecycle,
  error: unknown,
): Promise<void> {
  const cause = normalizeExecutionError(error)
  const snapshot = createNodeSnapshot(step.id, nodePath, "failed", lifecycle)
  snapshot.duration_ms = Date.now() - Date.parse(lifecycle.startedAt)
  snapshot.finished_at = new Date().toISOString()
  snapshot.stderr = cause.message
  snapshot.stderr_preview = cause.message
  await finishNode(environment, scope, step, snapshot)
}

async function recordLoopIterationFinished(
  environment: ExecutionEnvironment,
  frameId: FrameId,
  step: LoopNode,
  nodePath: NodePath,
  iteration: number,
  maxIterations: number,
  outcome: "continue" | "completed" | "failed",
): Promise<void> {
  await recordEvent(environment, {
    frame_id: frameId,
    iteration,
    kind: "loop_iteration_finished",
    max_iterations: maxIterations,
    node_path: nodePath,
    outcome,
    user_id: step.id ?? null,
  })
  emitProgress(environment, {
    frame_id: frameId,
    iteration,
    kind: "loop_iteration_finished",
    max_iterations: maxIterations,
    node_path: nodePath,
    outcome,
    user_id: step.id ?? null,
  })
}

async function recordEvent(environment: ExecutionEnvironment, event: RecordedRunEventInput): Promise<void> {
  await appendEvent(environment.recorder, {
    ts: new Date().toISOString(),
    ...event,
  })
}

function emitProgress(environment: ExecutionEnvironment, event: RunProgressEvent): void {
  environment.onProgress?.(event)
}

async function persistEnvironment(environment: ExecutionEnvironment): Promise<void> {
  if (environment.persistConversationSnapshot) {
    syncWorkflowConversations(environment.runState, environment.conversations)
  }
  await persistRunSnapshot(environment.recorder, environment.runState)
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
    stderr_path: null,
    stderr_preview: "",
    stdout: null,
    stdout_path: null,
    stdout_preview: "",
    user_id: userId ?? null,
  }
}

function preview(value: string): string {
  return value.replaceAll("\n", "\\n").slice(0, 160)
}

async function appendProviderLogs(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: ActionNode,
  nodePath: NodePath,
  attempt: number,
  events: ActionProviderEvent[],
  stdout: string,
  stderr: string,
): Promise<{ stderrPath?: string | undefined; stdoutPath?: string | undefined }> {
  let stdoutPath: string | undefined
  let stderrPath: string | undefined

  for (const event of events) {
    if (event.kind === "tool_use") {
      stdoutPath = await appendNodeLog(
        environment.recorder,
        scope.frameId,
        nodePath,
        attempt,
        "stdout",
        formatLogBlock("tool", event.detail === undefined ? event.tool : `${event.tool} ${event.detail}`),
      )
      continue
    }

    if (event.kind === "status") {
      if (event.provider === "codex" && containsExactBlock(stdout, event.message)) {
        continue
      }
      stdoutPath = await appendNodeLog(
        environment.recorder,
        scope.frameId,
        nodePath,
        attempt,
        "stdout",
        formatLogBlock("progress", event.message),
      )
      continue
    }

    if (event.provider === "codex" && containsExactBlock(stdout, event.message)) {
      continue
    }
    if (containsExactBlock(stderr, event.message)) {
      continue
    }
    stderrPath = await appendNodeLog(
      environment.recorder,
      scope.frameId,
      nodePath,
      attempt,
      "stderr",
      formatLogBlock("error", event.message),
    )
  }

  return { stderrPath, stdoutPath }
}

function emitProviderProgress(
  environment: ExecutionEnvironment,
  scope: ExecutionScope,
  step: ActionNode,
  nodePath: NodePath,
  event: ActionProviderEvent,
): void {
  if (event.kind === "tool_use") {
    emitProgress(environment, {
      detail: event.detail ?? null,
      frame_id: scope.frameId,
      kind: "provider_tool_use",
      node_path: nodePath,
      provider: event.provider,
      tool: event.tool,
      user_id: step.id ?? null,
    })
    return
  }
  if (event.kind === "status") {
    emitProgress(environment, {
      frame_id: scope.frameId,
      kind: "provider_status",
      message: event.message,
      node_path: nodePath,
      provider: event.provider,
      user_id: step.id ?? null,
    })
    return
  }
  emitProgress(environment, {
    frame_id: scope.frameId,
    kind: "provider_error",
    message: event.message,
    node_path: nodePath,
    provider: event.provider,
    user_id: step.id ?? null,
  })
}

function formatLogBlock(label: "error" | "progress" | "tool", text: string): string {
  const lines = text.length === 0 ? [""] : text.split(/\r?\n/)
  return lines
    .map((line, index) => `${index === 0 ? `  [${label}]` : "           "} ${line}`.trimEnd())
    .join("\n")
    .concat("\n")
}

function containsExactBlock(output: string, message: string): boolean {
  const messageLines = message.split(/\r?\n/)
  if (messageLines.length === 0) {
    return false
  }
  const outputLines = output.split(/\r?\n/)
  for (let index = 0; index <= outputLines.length - messageLines.length; index += 1) {
    if (outputLines.slice(index, index + messageLines.length).join("\n") === messageLines.join("\n")) {
      return true
    }
  }
  return false
}

function countNodes(steps: WorkflowStep[]): number {
  return steps.reduce((count, step) => {
    switch (step.type) {
      case "shell":
      case "claude":
      case "codex":
      case "write_file":
        return count + 1
      case "group":
        return count + 1 + countNodes(step.steps)
      case "loop":
        return count + 1 + countNodes(step.steps)
      case "branch":
        return count + 1 + step.cases.reduce((sum, branchCase) => sum + countNodes(branchCase.steps), 0)
      case "parallel":
        return count + 1 + step.branches.reduce((sum, branch) => sum + countNodes(branch.steps), 0)
    }
  }, 0)
}

function configHash(configFiles: string[], workflow: WorkflowDocument): string {
  const hasher = createHash("sha256")
  for (const file of configFiles) {
    hasher.update(file)
  }
  hasher.update(JSON.stringify(workflow))
  return hasher.digest("hex")
}

function stepLabel(step: ActionNode): string {
  switch (step.type) {
    case "shell":
      return step.with.command
    case "write_file":
      return `write_file ${step.with.path}`
    case "claude":
      return "claude"
    case "codex":
      return step.with.action === "review" ? "codex exec review" : "codex exec"
  }
}

function actionProvider(step: WorkflowStep): "claude" | "codex" | null {
  return step.type === "claude" ? "claude" : step.type === "codex" ? "codex" : null
}

function hasConversationBinding(step: ActionNode): boolean {
  if (step.type === "claude") {
    return step.with.conversation !== undefined
  }
  if (step.type === "codex" && step.with.action === "exec") {
    return step.with.conversation !== undefined
  }
  return false
}
