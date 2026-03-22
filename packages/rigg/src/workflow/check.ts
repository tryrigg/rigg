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
import type {
  ActionNode,
  BranchCase,
  BranchNode,
  CodexNode,
  CursorNode,
  GroupNode,
  LoopNode,
  ParallelNode,
  WorkflowDocument,
  WorkflowNode,
  WorkflowStep,
} from "./schema"
import { reviewOutput, checkDefs, checkValue } from "./input"
import { checkIdent } from "./id"
import { shapeFromSchema } from "./shape"
import { workflowById, type WorkflowProject } from "../project"
import { normalizeError } from "../util/error"

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
    errors.push(...validateWorkflow(project, file.workflow, file.filePath))
  }

  return errors
}

function validateWorkflow(project: WorkflowProject, workflow: WorkflowDocument, filePath: string): CompileDiagnostic[] {
  const errors: CompileDiagnostic[] = []
  const seenStepIds = new Set<string>()
  const rootScope: VisibleScope = {
    availableStepShapes: new Map(),
    inputDefinitions: workflow.inputs ?? {},
    insideLoop: false,
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

  validateStepList(project, workflow.id, workflow.steps, filePath, seenStepIds, rootScope, errors, [workflow.id])

  return errors
}

function validateStepList(
  project: WorkflowProject,
  workflowId: string,
  steps: WorkflowStep[],
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary {
  const availableStepShapes = new Map(scope.availableStepShapes)

  for (const step of steps) {
    const result = validateStep(
      project,
      workflowId,
      step,
      filePath,
      seenStepIds,
      {
        availableStepShapes,
        inputDefinitions: scope.inputDefinitions,
        insideLoop: scope.insideLoop,
      },
      errors,
      activeWorkflowIds,
    )

    if (step.id !== undefined) {
      availableStepShapes.set(step.id, result.guaranteedResultShape ?? result.resultShape)
    }
  }

  return {
    availableStepShapes,
  }
}

function validateStep(
  project: WorkflowProject,
  workflowId: string,
  step: WorkflowStep,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  if (step.id !== undefined) {
    const identifierError = checkIdent(step.id, "step id", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    } else if (seenStepIds.has(step.id)) {
      errors.push(
        createDiag(CompileDiagnosticCode.InvalidWorkflow, `Duplicate step id \`${step.id}\`.`, {
          filePath,
        }),
      )
    } else {
      seenStepIds.add(step.id)
    }
  }

  validateStepExpressions(step, filePath, scope, errors)

  const result = (() => {
    switch (step.type) {
      case "shell":
      case "write_file":
      case "codex":
      case "cursor":
        return validateActionStep(step, filePath, scope, errors)
      case "workflow":
        return validateWorkflowStep(project, workflowId, step, filePath, scope, errors, activeWorkflowIds)
      case "group":
        return validateGroupStep(project, workflowId, step, filePath, seenStepIds, scope, errors, activeWorkflowIds)
      case "loop":
        return validateLoopStep(project, workflowId, step, filePath, seenStepIds, scope, errors, activeWorkflowIds)
      case "branch":
        return validateBranchStep(project, workflowId, step, filePath, seenStepIds, scope, errors, activeWorkflowIds)
      case "parallel":
        return validateParallelStep(project, workflowId, step, filePath, seenStepIds, scope, errors, activeWorkflowIds)
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
      return {
        availableStepShapes: new Map(scope.availableStepShapes),
        guaranteedResultShape:
          step.with.result === "none" ? { kind: "none" } : step.with.result === "json" ? AnyJsonShape : StringShape,
        resultShape:
          step.with.result === "none" ? { kind: "none" } : step.with.result === "json" ? AnyJsonShape : StringShape,
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
    case "cursor":
      return validateCursor(step, filePath, scope, errors)
  }
}

function validateWorkflowStep(
  project: WorkflowProject,
  workflowId: string,
  step: WorkflowNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const referenceExpressions = extractExprs(step.with.workflow)
  if (referenceExpressions.length > 0) {
    errors.push(
      createDiag(
        CompileDiagnosticCode.InvalidWorkflow,
        "workflow reference must be a static string, not a template expression.",
        { filePath },
      ),
    )

    return {
      availableStepShapes: new Map(scope.availableStepShapes),
      guaranteedResultShape: NullShape,
      resultShape: NullShape,
    }
  }

  const targetWorkflow = workflowById(project, step.with.workflow)
  if (targetWorkflow === undefined) {
    errors.push(
      createDiag(
        CompileDiagnosticCode.InvalidWorkflow,
        `Step \`${step.id ?? "<anonymous>"}\` references workflow \`${step.with.workflow}\` which does not exist. Available workflows: ${
          project.files
            .map((file) => file.workflow.id)
            .sort()
            .join(", ") || "(none)"
        }.`,
        { filePath },
      ),
    )

    return {
      availableStepShapes: new Map(scope.availableStepShapes),
      guaranteedResultShape: NullShape,
      resultShape: NullShape,
    }
  }

  if (activeWorkflowIds.includes(targetWorkflow.id)) {
    errors.push(
      createDiag(
        CompileDiagnosticCode.InvalidWorkflow,
        `Step \`${step.id ?? "<anonymous>"}\` creates a circular workflow reference: ${[
          ...activeWorkflowIds,
          targetWorkflow.id,
        ].join(" -> ")}.`,
        { filePath },
      ),
    )
  } else {
    checkGraph(project, targetWorkflow, [...activeWorkflowIds, targetWorkflow.id], errors)
  }

  checkInputs(step, targetWorkflow, filePath, scope, errors)

  return {
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape: NullShape,
    resultShape: NullShape,
  }
}

function validateGroupStep(
  project: WorkflowProject,
  workflowId: string,
  step: GroupNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const inner = validateStepList(
    project,
    workflowId,
    step.steps,
    filePath,
    seenStepIds,
    scope,
    errors,
    activeWorkflowIds,
  )
  const resultShape = validateExports(
    step.exports,
    filePath,
    {
      ...scope,
      availableStepShapes: inner.availableStepShapes,
    },
    errors,
  )

  return {
    availableStepShapes: inner.availableStepShapes,
    guaranteedResultShape: resultShape,
    resultShape,
  }
}

function validateLoopStep(
  project: WorkflowProject,
  workflowId: string,
  step: LoopNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const loopScope = {
    ...scope,
    insideLoop: true,
  }
  const inner = validateStepList(
    project,
    workflowId,
    step.steps,
    filePath,
    seenStepIds,
    loopScope,
    errors,
    activeWorkflowIds,
  )
  checkExprTpl(
    step.until,
    filePath,
    {
      ...loopScope,
      availableStepShapes: inner.availableStepShapes,
    },
    errors,
    "bool",
  )

  const resultShape = validateExports(
    step.exports,
    filePath,
    {
      ...loopScope,
      availableStepShapes: inner.availableStepShapes,
    },
    errors,
  )

  return {
    availableStepShapes: inner.availableStepShapes,
    guaranteedResultShape: resultShape,
    resultShape,
  }
}

function validateBranchStep(
  project: WorkflowProject,
  workflowId: string,
  step: BranchNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  let seenElse = false
  const branchSummaries: Array<ValidationSummary & { exportShape: ResultShape }> = []

  for (const [index, caseNode] of step.cases.entries()) {
    const isElse = caseNode.else === true
    if (isElse && caseNode.if !== undefined) {
      errors.push(
        createDiag(CompileDiagnosticCode.InvalidWorkflow, `\`cases[${index}]\` cannot set both \`else\` and \`if\``, {
          filePath,
        }),
      )
    }
    if (!isElse && caseNode.if === undefined) {
      errors.push(
        createDiag(
          CompileDiagnosticCode.InvalidWorkflow,
          `\`cases[${index}]\` must define \`if\` unless it is an \`else\` case`,
          { filePath },
        ),
      )
    }
    if (isElse && index !== step.cases.length - 1) {
      errors.push(
        createDiag(CompileDiagnosticCode.InvalidWorkflow, "`else` case must be the last branch case", {
          filePath,
        }),
      )
    }
    if (isElse) {
      if (seenElse) {
        errors.push(
          createDiag(CompileDiagnosticCode.InvalidWorkflow, "`branch` may define at most one `else` case", {
            filePath,
          }),
        )
      }
      seenElse = true
    }

    const summary = validateBranchCase(
      project,
      workflowId,
      caseNode,
      filePath,
      seenStepIds,
      scope,
      errors,
      activeWorkflowIds,
    )
    branchSummaries.push(summary)
  }

  const anyExports = branchSummaries.some((summary) => summary.exportShape.kind !== "none")
  if (anyExports && !seenElse) {
    errors.push(
      createDiag(CompileDiagnosticCode.InvalidWorkflow, "`branch` without `else` cannot declare case `exports`", {
        filePath,
      }),
    )
  }
  if (anyExports && branchSummaries.some((summary) => summary.exportShape.kind === "none")) {
    errors.push(
      createDiag(
        CompileDiagnosticCode.InvalidWorkflow,
        "all `branch` cases must declare `exports` when any case exports a result",
        { filePath },
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
          errors.push(
            createDiag(
              CompileDiagnosticCode.InvalidWorkflow,
              "all `branch` case exports must declare the same result shape",
              { filePath },
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
  project: WorkflowProject,
  workflowId: string,
  step: ParallelNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const branchIds = new Set<string>()
  const branchSummaries: ValidationSummary[] = []
  const mergedStepShapes = new Map(scope.availableStepShapes)

  for (const [index, branch] of step.branches.entries()) {
    const identifierError = checkIdent(branch.id, "parallel branch id", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    } else if (branchIds.has(branch.id)) {
      errors.push(
        createDiag(
          CompileDiagnosticCode.InvalidWorkflow,
          `\`branches[${index}]\` reuses local branch id \`${branch.id}\` within the same parallel node`,
          { filePath },
        ),
      )
    } else {
      branchIds.add(branch.id)
    }

    const summary = validateStepList(
      project,
      workflowId,
      branch.steps,
      filePath,
      seenStepIds,
      scope,
      errors,
      activeWorkflowIds,
    )
    for (const [stepId, shape] of summary.availableStepShapes.entries()) {
      if (!scope.availableStepShapes.has(stepId)) {
        mergedStepShapes.set(stepId, shape)
      }
    }
    branchSummaries.push(summary)
  }

  const resultShape = validateExports(
    step.exports,
    filePath,
    {
      ...scope,
      availableStepShapes: mergedStepShapes,
    },
    errors,
  )

  return {
    availableStepShapes: mergedStepShapes,
    guaranteedResultShape: resultShape,
    resultShape,
  }
}

function validateBranchCase(
  project: WorkflowProject,
  workflowId: string,
  caseNode: BranchCase,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary & { exportShape: ResultShape } {
  if (caseNode.if !== undefined) {
    checkExprTpl(caseNode.if, filePath, scope, errors, "bool")
  }

  const summary = validateStepList(
    project,
    workflowId,
    caseNode.steps,
    filePath,
    seenStepIds,
    scope,
    errors,
    activeWorkflowIds,
  )
  const exportShape = validateExports(
    caseNode.exports,
    filePath,
    {
      ...scope,
      availableStepShapes: summary.availableStepShapes,
    },
    errors,
  )

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
  exportsMap: Record<string, string> | undefined,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ResultShape {
  if (exportsMap === undefined) {
    return { kind: "none" }
  }

  const fields: Record<string, ResultShape> = {}
  for (const [key, template] of Object.entries(exportsMap)) {
    const identifierError = checkIdent(key, "export name", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    }
    fields[key] = inferShape(template, filePath, scope, errors)
  }
  return { kind: "object", fields }
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
    return field === "iteration" || field === "max_iterations" ? IntegerShape : StringShape
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

function list(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)"
}

function cycle(ids: string[]): string {
  return ids.join(" -> ")
}
