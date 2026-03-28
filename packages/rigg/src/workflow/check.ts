import {
  compile,
  extractExprs,
  inferExpressionResultShape,
  isWholeTemplate,
  renderTemplate,
  type CompiledExpression,
  type PathReference,
} from "./expr"
import { createDiag, CompileDiagnosticCode, type CompileDiagnostic } from "./diag"
import type { InputDefinition } from "./input"
import { findYamlLoc, type YamlPath, type YamlSource } from "./parse"
import {
  AnyJsonShape,
  BooleanShape,
  IntegerShape,
  NullShape,
  NumberShape,
  StringShape,
  areResultShapesCompatible,
  descendShape,
  mergeShapes,
  resolveInputPath,
  validateResultShapePath,
  type ResultShape,
} from "./shape"
import {
  isRetryableStep,
  type ActionNode,
  type BranchCase,
  type BranchNode,
  type ClaudeNode,
  type CodexNode,
  type CursorNode,
  type OpenCodeNode,
  type GroupNode,
  type LoopNode,
  type ParallelNode,
  type WorkflowDocument,
  type WorkflowNode,
  type WorkflowStep,
} from "./schema"
import { reviewOutput, checkDefs, checkValue } from "./input"
import { checkIdent } from "./id"
import { shapeFromSchema } from "./shape"
import { parseModel } from "../opencode/model"
import { workflowById, type WorkflowProject } from "../project"
import { normalizeError } from "../util/error"
import { parseDuration } from "../util/duration"

type VisibleScope = CheckScope

type CheckScope = {
  availableStepShapes: Map<string, ResultShape>
  inputDefinitions: Record<string, InputDefinition>
  insideLoop: boolean
}

type ValidationSummary = {
  availableStepShapes: Map<string, ResultShape>
  guaranteedResultShape?: ResultShape | undefined
}

type ValidationContext = {
  activeWorkflowIds: string[]
  errors: CompileDiagnostic[]
  filePath: string
  path: YamlPath
  project: WorkflowProject
  seenStepIds: Set<string>
  source: YamlSource | undefined
}

export function checkWorkspace(project: WorkflowProject): CompileDiagnostic[] {
  const errors: CompileDiagnostic[] = []
  const seenWorkflowIds = new Set<string>()

  for (const file of project.files) {
    if (seenWorkflowIds.has(file.workflow.id)) {
      errors.push(
        createDiag(CompileDiagnosticCode.DuplicateWorkflowId, `Duplicate workflow id \`${file.workflow.id}\`.`, {
          filePath: file.filePath,
        }),
      )
      continue
    }

    seenWorkflowIds.add(file.workflow.id)
    errors.push(...validateWorkflow(project, file.workflow, file.filePath, file.source))
  }

  return errors
}

function validateWorkflow(
  project: WorkflowProject,
  workflow: WorkflowDocument,
  filePath: string,
  source?: YamlSource,
): CompileDiagnostic[] {
  const errors: CompileDiagnostic[] = []
  const rootScope: VisibleScope = {
    availableStepShapes: new Map(),
    inputDefinitions: workflow.inputs ?? {},
    insideLoop: false,
  }
  const ctx: ValidationContext = {
    activeWorkflowIds: [workflow.id],
    errors,
    filePath,
    path: [],
    project,
    seenStepIds: new Set<string>(),
    source,
  }

  for (const key of Object.keys(workflow.inputs ?? {})) {
    const identifierError = checkIdent(key, "input name", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    }
  }

  errors.push(
    ...checkDefs(workflow.inputs ?? {}).map((message) =>
      createDiag(CompileDiagnosticCode.InvalidWorkflow, message, { filePath }),
    ),
  )

  for (const value of Object.values(workflow.env ?? {})) {
    checkTpl(value, filePath, rootScope, errors)
  }

  validateStepList(childContext(ctx, "steps"), workflow.steps, rootScope)

  return errors
}

function validateStepList(ctx: ValidationContext, steps: WorkflowStep[], scope: VisibleScope): ValidationSummary {
  const availableStepShapes = new Map(scope.availableStepShapes)

  for (const [index, step] of steps.entries()) {
    const result = validateStep(childContext(ctx, index), step, {
      availableStepShapes,
      inputDefinitions: scope.inputDefinitions,
      insideLoop: scope.insideLoop,
    })

    if (step.id !== undefined) {
      availableStepShapes.set(step.id, result.guaranteedResultShape ?? result.resultShape)
    }
  }

  return {
    availableStepShapes,
  }
}

function validateStep(
  ctx: ValidationContext,
  step: WorkflowStep,
  scope: VisibleScope,
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  if (step.id !== undefined) {
    const identifierError = checkIdent(step.id, "step id", ctx.filePath)
    if (identifierError !== undefined) {
      ctx.errors.push(identifierError)
    } else if (ctx.seenStepIds.has(step.id)) {
      ctx.errors.push(
        createDiag(CompileDiagnosticCode.InvalidWorkflow, `Duplicate step id \`${step.id}\`.`, {
          filePath: ctx.filePath,
        }),
      )
    } else {
      ctx.seenStepIds.add(step.id)
    }
  }

  validateStepExpressions(step, ctx.filePath, scope, ctx.errors)
  validateRetry(ctx, step)

  const result = (() => {
    switch (step.type) {
      case "shell":
      case "write_file":
      case "claude":
      case "codex":
      case "cursor":
      case "opencode":
        return validateActionStep(step, ctx.filePath, scope, ctx.errors)
      case "workflow":
        return validateWorkflowStep(ctx, step, scope)
      case "group":
        return validateGroupStep(ctx, step, scope)
      case "loop":
        return validateLoopStep(ctx, step, scope)
      case "branch":
        return validateBranchStep(ctx, step, scope)
      case "parallel":
        return validateParallelStep(ctx, step, scope)
    }
  })()

  return {
    ...result,
    guaranteedResultShape: step.if === undefined ? result.resultShape : { kind: "none" },
  }
}

function validateActionStep(
  step: ActionNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  switch (step.type) {
    case "shell":
      checkTpl(step.with.command, filePath, scope, errors)
      const stdoutMode = step.with.stdout?.mode ?? "text"
      return {
        availableStepShapes: new Map(scope.availableStepShapes),
        guaranteedResultShape:
          stdoutMode === "none" ? { kind: "none" } : stdoutMode === "json" ? AnyJsonShape : StringShape,
        resultShape: stdoutMode === "none" ? { kind: "none" } : stdoutMode === "json" ? AnyJsonShape : StringShape,
      }
    case "write_file":
      checkTpl(step.with.path, filePath, scope, errors)
      checkTpl(step.with.content, filePath, scope, errors)
      return {
        availableStepShapes: new Map(scope.availableStepShapes),
        guaranteedResultShape: { kind: "object", fields: { path: StringShape } },
        resultShape: { kind: "object", fields: { path: StringShape } },
      }
    case "codex":
      return validateCodex(step, filePath, scope, errors)
    case "claude":
      return validateClaude(step, filePath, scope, errors)
    case "cursor":
      return validateCursor(step, filePath, scope, errors)
    case "opencode":
      return validateOpenCode(step, filePath, scope, errors)
  }
}

function validateWorkflowStep(
  ctx: ValidationContext,
  step: WorkflowNode,
  scope: VisibleScope,
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const workflowCtx = childContext(ctx, "with", "workflow")
  const referenceExpressions = extractExprs(step.with.workflow)
  if (referenceExpressions.length > 0) {
    ctx.errors.push(
      diagAt(
        workflowCtx,
        CompileDiagnosticCode.InvalidWorkflow,
        "workflow reference must be a static string, not a template expression.",
      ),
    )

    return {
      availableStepShapes: new Map(scope.availableStepShapes),
      guaranteedResultShape: NullShape,
      resultShape: NullShape,
    }
  }

  const targetWorkflow = workflowById(ctx.project, step.with.workflow)
  if (targetWorkflow === undefined) {
    ctx.errors.push(
      diagAt(
        workflowCtx,
        CompileDiagnosticCode.InvalidWorkflow,
        `Step \`${step.id ?? "<anonymous>"}\` references workflow \`${step.with.workflow}\` which does not exist. Available workflows: ${
          ctx.project.files
            .map((file) => file.workflow.id)
            .sort()
            .join(", ") || "(none)"
        }.`,
      ),
    )

    return {
      availableStepShapes: new Map(scope.availableStepShapes),
      guaranteedResultShape: NullShape,
      resultShape: NullShape,
    }
  }

  if (ctx.activeWorkflowIds.includes(targetWorkflow.id)) {
    ctx.errors.push(
      diagAt(
        workflowCtx,
        CompileDiagnosticCode.InvalidWorkflow,
        `Step \`${step.id ?? "<anonymous>"}\` creates a circular workflow reference: ${[...ctx.activeWorkflowIds, targetWorkflow.id].join(" -> ")}.`,
      ),
    )
  } else {
    checkGraph(ctx.project, targetWorkflow, [...ctx.activeWorkflowIds, targetWorkflow.id], ctx.errors)
  }

  checkInputs(step, targetWorkflow, ctx.filePath, scope, ctx.errors)

  return {
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape: NullShape,
    resultShape: NullShape,
  }
}

function validateGroupStep(
  ctx: ValidationContext,
  step: GroupNode,
  scope: VisibleScope,
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const inner = validateStepList(childContext(ctx, "steps"), step.steps, scope)
  const resultShape = validateExports(childContext(ctx, "exports"), step.exports, {
    ...scope,
    availableStepShapes: inner.availableStepShapes,
  })

  return {
    availableStepShapes: inner.availableStepShapes,
    guaranteedResultShape: resultShape,
    resultShape,
  }
}

function validateLoopStep(
  ctx: ValidationContext,
  step: LoopNode,
  scope: VisibleScope,
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const loopScope = {
    ...scope,
    insideLoop: true,
  }
  const inner = validateStepList(childContext(ctx, "steps"), step.steps, loopScope)
  if (step.until !== undefined) {
    checkExprTpl(
      step.until,
      ctx.filePath,
      {
        ...loopScope,
        availableStepShapes: inner.availableStepShapes,
      },
      ctx.errors,
      "bool",
    )
  }

  const exportsShape = validateExports(
    childContext(ctx, "exports"),
    step.exports,
    {
      ...loopScope,
      availableStepShapes: inner.availableStepShapes,
    },
    {
      reserved: new Set(["reason"]),
      reservedMessage: "`loop.exports.reason` is reserved for the loop completion reason",
    },
  )
  const resultShape = loopResultShape(exportsShape)

  return {
    availableStepShapes: inner.availableStepShapes,
    guaranteedResultShape: resultShape,
    resultShape,
  }
}

function validateBranchStep(
  ctx: ValidationContext,
  step: BranchNode,
  scope: VisibleScope,
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  let seenElse = false
  const branchSummaries: Array<ValidationSummary & { exportShape: ResultShape }> = []

  for (const [index, caseNode] of step.cases.entries()) {
    const isElse = caseNode.else === true
    if (isElse && caseNode.if !== undefined) {
      ctx.errors.push(
        createDiag(CompileDiagnosticCode.InvalidWorkflow, `\`cases[${index}]\` cannot set both \`else\` and \`if\``, {
          filePath: ctx.filePath,
        }),
      )
    }
    if (!isElse && caseNode.if === undefined) {
      ctx.errors.push(
        createDiag(
          CompileDiagnosticCode.InvalidWorkflow,
          `\`cases[${index}]\` must define \`if\` unless it is an \`else\` case`,
          { filePath: ctx.filePath },
        ),
      )
    }
    if (isElse && index !== step.cases.length - 1) {
      ctx.errors.push(
        createDiag(CompileDiagnosticCode.InvalidWorkflow, "`else` case must be the last branch case", {
          filePath: ctx.filePath,
        }),
      )
    }
    if (isElse) {
      if (seenElse) {
        ctx.errors.push(
          createDiag(CompileDiagnosticCode.InvalidWorkflow, "`branch` may define at most one `else` case", {
            filePath: ctx.filePath,
          }),
        )
      }
      seenElse = true
    }

    const summary = validateBranchCase(childContext(ctx, "cases", index), caseNode, scope)
    branchSummaries.push(summary)
  }

  const anyExports = branchSummaries.some((summary) => summary.exportShape.kind !== "none")
  if (anyExports && !seenElse) {
    ctx.errors.push(
      createDiag(CompileDiagnosticCode.InvalidWorkflow, "`branch` without `else` cannot declare case `exports`", {
        filePath: ctx.filePath,
      }),
    )
  }
  if (anyExports && branchSummaries.some((summary) => summary.exportShape.kind === "none")) {
    ctx.errors.push(
      createDiag(
        CompileDiagnosticCode.InvalidWorkflow,
        "all `branch` cases must declare `exports` when any case exports a result",
        { filePath: ctx.filePath },
      ),
    )
  }

  let branchResultShape: ResultShape = { kind: "none" }
  if (anyExports) {
    const shapes = branchSummaries.map((summary) => summary.exportShape).filter((shape) => shape.kind !== "none")
    const [firstShape, ...restShapes] = shapes
    if (firstShape !== undefined) {
      branchResultShape = firstShape
      for (const shape of restShapes) {
        const merged = mergeShapes(branchResultShape, shape)
        if (!areResultShapesCompatible(branchResultShape, shape)) {
          ctx.errors.push(
            createDiag(
              CompileDiagnosticCode.InvalidWorkflow,
              "all `branch` case exports must declare the same result shape",
              { filePath: ctx.filePath },
            ),
          )
          branchResultShape = AnyJsonShape
          break
        }
        branchResultShape = merged
      }
    }
  }

  return {
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape: branchResultShape,
    resultShape: branchResultShape,
  }
}

function validateParallelStep(
  ctx: ValidationContext,
  step: ParallelNode,
  scope: VisibleScope,
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const branchIds = new Set<string>()
  const branchSummaries: ValidationSummary[] = []
  const mergedStepShapes = new Map(scope.availableStepShapes)

  for (const [index, branch] of step.branches.entries()) {
    const identifierError = checkIdent(branch.id, "parallel branch id", ctx.filePath)
    if (identifierError !== undefined) {
      ctx.errors.push(identifierError)
    } else if (branchIds.has(branch.id)) {
      ctx.errors.push(
        createDiag(
          CompileDiagnosticCode.InvalidWorkflow,
          `\`branches[${index}]\` reuses local branch id \`${branch.id}\` within the same parallel node`,
          { filePath: ctx.filePath },
        ),
      )
    } else {
      branchIds.add(branch.id)
    }

    const summary = validateStepList(childContext(ctx, "branches", index, "steps"), branch.steps, scope)
    for (const [stepId, shape] of summary.availableStepShapes.entries()) {
      if (!scope.availableStepShapes.has(stepId)) {
        mergedStepShapes.set(stepId, shape)
      }
    }
    branchSummaries.push(summary)
  }

  const resultShape = validateExports(childContext(ctx, "exports"), step.exports, {
    ...scope,
    availableStepShapes: mergedStepShapes,
  })

  return {
    availableStepShapes: mergedStepShapes,
    guaranteedResultShape: resultShape,
    resultShape,
  }
}

function validateBranchCase(
  ctx: ValidationContext,
  caseNode: BranchCase,
  scope: VisibleScope,
): ValidationSummary & { exportShape: ResultShape } {
  if (caseNode.if !== undefined) {
    checkExprTpl(caseNode.if, ctx.filePath, scope, ctx.errors, "bool")
  }

  const summary = validateStepList(childContext(ctx, "steps"), caseNode.steps, scope)
  const exportShape = validateExports(childContext(ctx, "exports"), caseNode.exports, {
    ...scope,
    availableStepShapes: summary.availableStepShapes,
  })

  return { ...summary, exportShape }
}

function validateCodex(
  step: CodexNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  if (step.with.kind === "review") {
    if (step.with.target.type === "base") {
      checkTpl(step.with.target.branch, filePath, scope, errors)
    }
    if (step.with.target.type === "commit") {
      checkTpl(step.with.target.sha, filePath, scope, errors)
    }

    const reviewShape = shapeFromSchema(reviewOutput())
    return {
      availableStepShapes: new Map(scope.availableStepShapes),
      guaranteedResultShape: reviewShape,
      resultShape: reviewShape,
    }
  }

  checkTpl(step.with.prompt, filePath, scope, errors)
  return {
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape: StringShape,
    resultShape: StringShape,
  }
}

function validateCursor(
  step: CursorNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  checkTpl(step.with.prompt, filePath, scope, errors)
  return {
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape: StringShape,
    resultShape: StringShape,
  }
}

function validateClaude(
  step: ClaudeNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  checkTpl(step.with.prompt, filePath, scope, errors)
  return {
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape: StringShape,
    resultShape: StringShape,
  }
}

function validateOpenCode(
  step: OpenCodeNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  checkTpl(step.with.prompt, filePath, scope, errors)
  const model = parseModel(step.with.model)
  if (model.kind === "invalid") {
    errors.push(createDiag(CompileDiagnosticCode.InvalidWorkflow, model.message, { filePath }))
  }
  return {
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape: StringShape,
    resultShape: StringShape,
  }
}

function validateStepExpressions(
  step: WorkflowStep,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): void {
  if (step.if !== undefined) {
    checkExprTpl(step.if, filePath, scope, errors, "bool")
  }

  for (const value of Object.values(step.env ?? {})) {
    checkTpl(value, filePath, scope, errors)
  }
}

function validateExports(
  ctx: ValidationContext,
  exportsMap: Record<string, string> | undefined,
  scope: VisibleScope,
  options: {
    reserved?: Set<string>
    reservedMessage?: string
  } = {},
): ResultShape {
  if (exportsMap === undefined) {
    return { kind: "none" }
  }

  const fields: Record<string, ResultShape> = {}
  for (const [key, template] of Object.entries(exportsMap)) {
    const identifierError = checkIdent(key, "export name", ctx.filePath)
    if (identifierError !== undefined) {
      ctx.errors.push(identifierError)
    }
    if (options.reserved?.has(key)) {
      ctx.errors.push(
        diagAt(
          childContext(ctx, key),
          CompileDiagnosticCode.InvalidWorkflow,
          options.reservedMessage ?? `\`exports.${key}\` is reserved`,
        ),
      )
      continue
    }
    fields[key] = inferShape(template, ctx.filePath, scope, ctx.errors)
  }
  return { kind: "object", fields }
}

function validateRetry(ctx: ValidationContext, step: WorkflowStep): void {
  const retry = "retry" in step ? step.retry : undefined
  if (retry === undefined) {
    return
  }

  if (!isRetryableStep(step)) {
    ctx.errors.push(
      diagAt(
        childContext(ctx, "retry"),
        CompileDiagnosticCode.InvalidWorkflow,
        "`retry` is only supported on action and workflow steps",
      ),
    )
    return
  }

  const cfg = retryOptions(retry)

  if (cfg.delay !== undefined && parseDuration(cfg.delay) === null) {
    ctx.errors.push(
      diagAt(
        childContext(ctx, "retry", "delay"),
        CompileDiagnosticCode.InvalidWorkflow,
        "`retry.delay` must be a duration like `500ms`, `1s`, `2m`, or `1h`",
      ),
    )
  }

  if (cfg.backoff !== undefined && (cfg.backoff < 1 || cfg.backoff > 10)) {
    ctx.errors.push(
      diagAt(
        childContext(ctx, "retry", "backoff"),
        CompileDiagnosticCode.InvalidWorkflow,
        "`retry.backoff` must be between 1 and 10",
        cfg.backoff < 1
          ? ["Use `1` for a fixed delay or a larger multiplier for exponential backoff."]
          : ["Keep backoff at `10` or below to avoid runaway retry delays."],
      ),
    )
  }
}

function checkGraph(
  project: WorkflowProject,
  workflow: WorkflowDocument,
  activeIds: string[],
  errors: CompileDiagnostic[],
): void {
  const filePath = filePathFor(project, workflow.id)
  if (filePath === undefined) {
    return
  }

  walkCalls(workflow.steps, (step) => {
    if (extractExprs(step.with.workflow).length > 0) {
      return
    }

    const target = workflowById(project, step.with.workflow)
    if (target === undefined) {
      return
    }

    if (activeIds.includes(target.id)) {
      errors.push(
        createDiag(
          CompileDiagnosticCode.InvalidWorkflow,
          `Step \`${step.id ?? "<anonymous>"}\` creates a circular workflow reference: ${cycle([...activeIds, target.id])}.`,
          { filePath },
        ),
      )
      return
    }

    checkGraph(project, target, [...activeIds, target.id], errors)
  })
}

function checkInputs(
  step: WorkflowNode,
  workflow: WorkflowDocument,
  filePath: string,
  scope: CheckScope,
  errors: CompileDiagnostic[],
): void {
  const provided = step.with.inputs ?? {}
  const declared = workflow.inputs ?? {}
  const names = Object.keys(declared).sort()

  for (const [key, value] of Object.entries(provided)) {
    const schema = declared[key]
    if (schema === undefined) {
      errors.push(
        createDiag(
          CompileDiagnosticCode.InvalidWorkflow,
          `Step \`${step.id ?? "<anonymous>"}\` provides input \`${key}\` which is not declared by workflow \`${step.with.workflow}\`. Declared inputs: ${list(names)}.`,
          { filePath },
        ),
      )
      continue
    }

    checkInput(step, key, value, schema, filePath, scope, errors)
  }

  for (const [key, schema] of Object.entries(declared)) {
    if (key in provided || schema.default !== undefined) {
      continue
    }

    errors.push(
      createDiag(
        CompileDiagnosticCode.InvalidWorkflow,
        `Step \`${step.id ?? "<anonymous>"}\` does not provide required input \`${key}\` for workflow \`${step.with.workflow}\`.`,
        { filePath },
      ),
    )
  }
}

function checkInput(
  step: WorkflowNode,
  key: string,
  value: unknown,
  schema: InputDefinition,
  filePath: string,
  scope: CheckScope,
  errors: CompileDiagnostic[],
): void {
  const path = `Step \`${step.id ?? "<anonymous>"}\` input \`${key}\` for workflow \`${step.with.workflow}\``

  if (typeof value !== "string") {
    for (const message of checkValue(schema, value, path)) {
      errors.push(createDiag(CompileDiagnosticCode.InvalidWorkflow, message, { filePath }))
    }
    return
  }

  const exprs = extractExprs(value)
  if (exprs.length === 0) {
    const normalized = parseLiteral(schema, value)
    for (const message of checkValue(schema, normalized, path)) {
      errors.push(createDiag(CompileDiagnosticCode.InvalidWorkflow, message, { filePath }))
    }
    return
  }

  if (schema.type !== "string" && !isWholeTemplate(value)) {
    checkMixedInput(value, schema, path, filePath, scope, errors)
    return
  }

  checkTpl(value, filePath, scope, errors)
  const shape = inferInputShape(value, filePath, scope, errors)
  if (!inputShapeFits(shape, schema)) {
    errors.push(
      createDiag(
        CompileDiagnosticCode.InvalidWorkflow,
        `${path} expects a ${schema.type} value, but the provided template resolves to ${describeShape(shape)}.`,
        { filePath },
      ),
    )
  }
}

function checkMixedInput(
  template: string,
  schema: InputDefinition,
  path: string,
  filePath: string,
  scope: CheckScope,
  errors: CompileDiagnostic[],
): void {
  const compiled = extractExprs(template)
    .map((expr) => checkExpr(expr, filePath, scope, errors, "scalar"))
    .filter((expr): expr is NonNullable<typeof expr> => expr !== undefined)

  if (compiled.length === 0) {
    return
  }

  if (compiled.some((expr) => expr.pathReferences.length > 0)) {
    errors.push(
      createDiag(
        CompileDiagnosticCode.InvalidWorkflow,
        `${path} expects a ${schema.type} value, but mixed templates with dynamic expressions can only guarantee string output. Use a whole \`${"${{ ... }}"}\` expression instead.`,
        { filePath },
      ),
    )
    return
  }

  let rendered: unknown
  try {
    rendered = renderTemplate(template, { env: {}, inputs: {}, run: {}, steps: {} })
  } catch (error) {
    const cause = normalizeError(error)
    errors.push(createDiag(CompileDiagnosticCode.InvalidExpression, cause.message, { filePath, cause }))
    return
  }

  const normalized = typeof rendered === "string" ? parseLiteral(schema, rendered) : rendered
  for (const message of checkValue(schema, normalized, path)) {
    errors.push(createDiag(CompileDiagnosticCode.InvalidWorkflow, message, { filePath }))
  }
}

function inferInputShape(
  template: string,
  filePath: string,
  scope: CheckScope,
  errors: CompileDiagnostic[],
): ResultShape {
  if (!isWholeTemplate(template)) {
    return AnyJsonShape
  }
  const compiled = checkWholeTpl(template, filePath, scope, errors)
  return compiled === undefined ? AnyJsonShape : inferShape(template, filePath, scope, errors)
}

function inputShapeFits(provided: ResultShape, schema: InputDefinition): boolean {
  if (provided.kind === "any_json") {
    return true
  }

  switch (schema.type) {
    case "string":
      return areResultShapesCompatible(provided, StringShape)
    case "integer":
      return areResultShapesCompatible(provided, IntegerShape)
    case "number":
      return areResultShapesCompatible(provided, NumberShape)
    case "boolean":
      return areResultShapesCompatible(provided, BooleanShape)
    case "array":
      if (provided.kind !== "array") {
        return false
      }
      if (schema.items === undefined || provided.items === undefined) {
        return true
      }
      return inputShapeFits(provided.items, schema.items)
    case "object":
      if (provided.kind !== "object") {
        return false
      }
      for (const key of schema.required ?? []) {
        if (!(key in provided.fields)) {
          return false
        }
      }
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        const field = provided.fields[key]
        if (field !== undefined && !inputShapeFits(field, prop)) {
          return false
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(provided.fields)) {
          if (!(key in (schema.properties ?? {}))) {
            return false
          }
        }
      }
      return true
  }
}

function parseLiteral(schema: InputDefinition, value: string): unknown {
  if (schema.type === "string") {
    return value
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed === null ? value : parsed
  } catch {
    return value
  }
}

function checkTpl(template: string, filePath: string, scope: CheckScope, errors: CompileDiagnostic[]): void {
  for (const expr of extractExprs(template)) {
    checkExpr(expr, filePath, scope, errors)
  }
}

function checkExprTpl(
  template: string,
  filePath: string,
  scope: CheckScope,
  errors: CompileDiagnostic[],
  expected: "bool" | "scalar" | null = null,
): void {
  checkWholeTpl(template, filePath, scope, errors, expected)
}

function checkWholeTpl(
  template: string,
  filePath: string,
  scope: CheckScope,
  errors: CompileDiagnostic[],
  expected: "bool" | "scalar" | null = null,
): CompiledExpression | undefined {
  if (!isWholeTemplate(template)) {
    errors.push(
      createDiag(CompileDiagnosticCode.InvalidExpression, "Expected a whole `${{ ... }}` expression.", {
        filePath,
      }),
    )
    for (const expr of extractExprs(template)) {
      checkExpr(expr, filePath, scope, errors, expected)
    }
    return undefined
  }

  const [expr] = extractExprs(template)
  if (expr === undefined) {
    errors.push(
      createDiag(CompileDiagnosticCode.InvalidExpression, "Expected a whole `${{ ... }}` expression.", {
        filePath,
      }),
    )
    return undefined
  }

  return checkExpr(expr, filePath, scope, errors, expected)
}

function checkExpr(
  expr: string,
  filePath: string,
  scope: CheckScope,
  errors: CompileDiagnostic[],
  expected: "bool" | "scalar" | null = null,
): CompiledExpression | undefined {
  let compiled: CompiledExpression
  try {
    compiled = compile(expr, expected)
  } catch (error) {
    const cause = normalizeError(error)
    errors.push(createDiag(CompileDiagnosticCode.InvalidExpression, cause.message, { filePath, cause }))
    return undefined
  }

  for (const ref of compiled.pathReferences) {
    const message = checkRef(ref, scope)
    if (message !== undefined) {
      errors.push(createDiag(CompileDiagnosticCode.ReferenceError, message, { filePath }))
    }
  }

  return compiled
}

function inferShape(template: string, filePath: string, scope: CheckScope, errors: CompileDiagnostic[]): ResultShape {
  const compiled = checkWholeTpl(template, filePath, scope, errors)
  return compiled === undefined ? AnyJsonShape : inferExpressionResultShape(compiled, (ref) => resolveShape(ref, scope))
}

function describeShape(shape: ResultShape): string {
  switch (shape.kind) {
    case "any_json":
      return "any JSON"
    case "null":
      return "null"
    case "none":
      return "no value"
    case "string":
      return "string"
    case "integer":
      return "integer"
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    case "array":
      return "array"
    case "object":
      return "object"
  }
}

function resolveShape(ref: PathReference, scope: CheckScope): ResultShape {
  if (ref.root === "inputs") {
    const [name, ...rest] = ref.segments
    if (name === undefined) {
      return AnyJsonShape
    }
    const schema = scope.inputDefinitions[name]
    if (schema === undefined) {
      return AnyJsonShape
    }
    const out = resolveInputPath(schema, `inputs.${name}`, rest)
    return out.kind === "ok" ? out.shape : AnyJsonShape
  }

  if (ref.root === "steps") {
    const [stepId, ...rest] = ref.segments
    if (stepId === undefined) {
      return AnyJsonShape
    }
    let shape = scope.availableStepShapes.get(stepId) ?? AnyJsonShape
    const path = rest[0] === "result" ? rest.slice(1) : []
    for (const seg of path) {
      shape = descendShape(shape, seg)
    }
    return shape
  }

  if (ref.root === "run") {
    const [field] = ref.segments
    if (field === "iteration") {
      return IntegerShape
    }
    if (field === "max_iterations") {
      return mergeShapes(IntegerShape, NullShape)
    }
    return StringShape
  }

  return AnyJsonShape
}

function checkRef(ref: PathReference, scope: CheckScope): string | undefined {
  if (ref.root === "inputs") {
    const [name, ...rest] = ref.segments
    if (name === undefined) {
      return "`inputs` must reference a declared field"
    }
    const schema = scope.inputDefinitions[name]
    if (schema === undefined) {
      return `\`inputs.${name}\` is not declared by the workflow`
    }
    const out = resolveInputPath(schema, `inputs.${name}`, rest)
    return out.kind === "error" ? out.message : undefined
  }

  if (ref.root === "run") {
    if (!scope.insideLoop) {
      return "`run.*` is only available inside loops."
    }
    const [field, ...rest] = ref.segments
    if (field === undefined) {
      return undefined
    }
    if (field !== "iteration" && field !== "max_iterations" && field !== "node_path") {
      return "`run` only exposes `iteration`, `max_iterations`, and `node_path`"
    }
    if (rest.length > 0) {
      return `\`run.${field}\` does not support nested field access`
    }
    return undefined
  }

  if (ref.root === "steps") {
    const [stepId, access, ...rest] = ref.segments
    if (stepId === undefined) {
      return "`steps` must reference a previous step id"
    }
    const shape = scope.availableStepShapes.get(stepId)
    if (shape === undefined) {
      return `Expression references step \`${stepId}\` before it is available.`
    }
    if (access === undefined) {
      return `\`steps.${stepId}\` must access \`.result\``
    }
    if (access !== "result") {
      return `\`steps.${stepId}.${access}\` is not available; use \`steps.${stepId}.result\``
    }
    return validateResultShapePath(stepId, shape, rest)
  }

  return undefined
}

function walkCalls(steps: WorkflowStep[], visit: (step: WorkflowNode) => void): void {
  for (const step of steps) {
    switch (step.type) {
      case "workflow":
        visit(step)
        break
      case "group":
      case "loop":
        walkCalls(step.steps, visit)
        break
      case "branch":
        for (const item of step.cases) {
          walkCalls(item.steps, visit)
        }
        break
      case "parallel":
        for (const branch of step.branches) {
          walkCalls(branch.steps, visit)
        }
        break
      case "shell":
      case "claude":
      case "codex":
      case "cursor":
      case "write_file":
        break
    }
  }
}

function filePathFor(project: WorkflowProject, workflowId: string): string | undefined {
  return project.files.find((file) => file.workflow.id === workflowId)?.filePath
}

function diagAt(
  ctx: ValidationContext,
  code: (typeof CompileDiagnosticCode)[keyof typeof CompileDiagnosticCode],
  message: string,
  hints?: string[],
): CompileDiagnostic {
  const loc = findYamlLoc(ctx.source, ctx.path)
  return createDiag(code, message, {
    filePath: ctx.filePath,
    ...(loc ?? {}),
    ...(hints === undefined ? {} : { hints }),
  })
}

function childContext(ctx: ValidationContext, ...path: Array<string | number>): ValidationContext {
  return {
    ...ctx,
    path: [...ctx.path, ...path],
  }
}

function loopResultShape(shape: ResultShape): ResultShape {
  return {
    kind: "object",
    fields: {
      ...(shape.kind === "object" ? shape.fields : {}),
      reason: StringShape,
    },
  }
}

function retryOptions(retry: number | { backoff?: unknown; delay?: unknown; max: number }): {
  backoff?: number | undefined
  delay?: string | undefined
  max: number
} {
  if (typeof retry === "number") {
    return { max: retry }
  }
  return {
    backoff: typeof retry.backoff === "number" ? retry.backoff : undefined,
    delay: typeof retry.delay === "string" ? retry.delay : undefined,
    max: retry.max,
  }
}

function list(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)"
}

function cycle(ids: string[]): string {
  return ids.join(" -> ")
}
