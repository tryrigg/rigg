import {
  AnyJsonShape,
  IntegerShape,
  StringShape,
  compileExpression,
  extractTemplateExpressions,
  inferExpressionResultShape,
  isWholeExpressionTemplate,
  mergeResultShapes,
  type CompiledExpression,
  type PathReference,
  type ResultShape,
} from "./expr"
import { createCompileDiagnostic, CompileDiagnosticCode, type CompileDiagnostic } from "./diagnostic"
import type {
  ActionNode,
  BranchCase,
  BranchNode,
  CodexNode,
  GroupNode,
  InputDefinition,
  LoopNode,
  ParallelNode,
  WorkflowDocument,
  WorkflowStep,
} from "./schema"
import {
  areResultShapesCompatible,
  codexReviewOutputDefinition,
  descendResultShape,
  shapeFromSchema,
  resolveInputPathShape,
  validateResultShapePath,
  validateIdentifier,
  validateInputDefinitions,
} from "./schema"
import type { WorkflowProject } from "./project"
import { normalizeError } from "../util/error"

type VisibleScope = {
  availableStepShapes: Map<string, ResultShape>
  inputDefinitions: Record<string, InputDefinition>
  insideLoop: boolean
}

type ValidationSummary = {
  availableStepShapes: Map<string, ResultShape>
  guaranteedResultShape?: ResultShape | undefined
}

export function validateWorkspace(project: WorkflowProject): CompileDiagnostic[] {
  const errors: CompileDiagnostic[] = []
  const seenWorkflowIds = new Set<string>()

  for (const file of project.files) {
    if (seenWorkflowIds.has(file.workflow.id)) {
      errors.push(
        createCompileDiagnostic(
          CompileDiagnosticCode.DuplicateWorkflowId,
          `Duplicate workflow id \`${file.workflow.id}\`.`,
          {
            filePath: file.filePath,
          },
        ),
      )
      continue
    }

    seenWorkflowIds.add(file.workflow.id)
    errors.push(...validateWorkflow(file.workflow, file.filePath))
  }

  return errors
}

function validateWorkflow(workflow: WorkflowDocument, filePath: string): CompileDiagnostic[] {
  const errors: CompileDiagnostic[] = []
  const seenStepIds = new Set<string>()
  const rootScope: VisibleScope = {
    availableStepShapes: new Map(),
    inputDefinitions: workflow.inputs ?? {},
    insideLoop: false,
  }

  for (const key of Object.keys(workflow.inputs ?? {})) {
    const identifierError = validateIdentifier(key, "input name", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    }
  }

  errors.push(
    ...validateInputDefinitions(workflow.inputs ?? {}).map((message) =>
      createCompileDiagnostic(CompileDiagnosticCode.InvalidWorkflow, message, { filePath }),
    ),
  )

  for (const value of Object.values(workflow.env ?? {})) {
    validateTemplate(value, filePath, rootScope, errors)
  }

  validateStepList(workflow.steps, filePath, seenStepIds, rootScope, errors)

  return errors
}

function validateStepList(
  steps: WorkflowStep[],
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary {
  const availableStepShapes = new Map(scope.availableStepShapes)

  for (const step of steps) {
    const result = validateStep(
      step,
      filePath,
      seenStepIds,
      {
        availableStepShapes,
        inputDefinitions: scope.inputDefinitions,
        insideLoop: scope.insideLoop,
      },
      errors,
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
  step: WorkflowStep,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  if (step.id !== undefined) {
    const identifierError = validateIdentifier(step.id, "step id", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    } else if (seenStepIds.has(step.id)) {
      errors.push(
        createCompileDiagnostic(CompileDiagnosticCode.InvalidWorkflow, `Duplicate step id \`${step.id}\`.`, {
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
        return validateActionStep(step, filePath, scope, errors)
      case "group":
        return validateGroupStep(step, filePath, seenStepIds, scope, errors)
      case "loop":
        return validateLoopStep(step, filePath, seenStepIds, scope, errors)
      case "branch":
        return validateBranchStep(step, filePath, seenStepIds, scope, errors)
      case "parallel":
        return validateParallelStep(step, filePath, seenStepIds, scope, errors)
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
      validateTemplate(step.with.command, filePath, scope, errors)
      return {
        availableStepShapes: new Map(scope.availableStepShapes),
        guaranteedResultShape:
          step.with.result === "none" ? { kind: "none" } : step.with.result === "json" ? AnyJsonShape : StringShape,
        resultShape:
          step.with.result === "none" ? { kind: "none" } : step.with.result === "json" ? AnyJsonShape : StringShape,
      }
    case "write_file":
      validateTemplate(step.with.path, filePath, scope, errors)
      validateTemplate(step.with.content, filePath, scope, errors)
      return {
        availableStepShapes: new Map(scope.availableStepShapes),
        guaranteedResultShape: { kind: "object", fields: { path: StringShape } },
        resultShape: { kind: "object", fields: { path: StringShape } },
      }
    case "codex":
      return validateCodex(step, filePath, scope, errors)
  }
}

function validateGroupStep(
  step: GroupNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const inner = validateStepList(step.steps, filePath, seenStepIds, scope, errors)
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
  step: LoopNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const loopScope = {
    ...scope,
    insideLoop: true,
  }
  const inner = validateStepList(step.steps, filePath, seenStepIds, loopScope, errors)
  validateExpressionTemplate(
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
  step: BranchNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  let seenElse = false
  const branchSummaries: Array<ValidationSummary & { exportShape: ResultShape }> = []

  for (const [index, caseNode] of step.cases.entries()) {
    const isElse = caseNode.else === true
    if (isElse && caseNode.if !== undefined) {
      errors.push(
        createCompileDiagnostic(
          CompileDiagnosticCode.InvalidWorkflow,
          `\`cases[${index}]\` cannot set both \`else\` and \`if\``,
          { filePath },
        ),
      )
    }
    if (!isElse && caseNode.if === undefined) {
      errors.push(
        createCompileDiagnostic(
          CompileDiagnosticCode.InvalidWorkflow,
          `\`cases[${index}]\` must define \`if\` unless it is an \`else\` case`,
          { filePath },
        ),
      )
    }
    if (isElse && index !== step.cases.length - 1) {
      errors.push(
        createCompileDiagnostic(CompileDiagnosticCode.InvalidWorkflow, "`else` case must be the last branch case", {
          filePath,
        }),
      )
    }
    if (isElse) {
      if (seenElse) {
        errors.push(
          createCompileDiagnostic(
            CompileDiagnosticCode.InvalidWorkflow,
            "`branch` may define at most one `else` case",
            {
              filePath,
            },
          ),
        )
      }
      seenElse = true
    }

    const summary = validateBranchCase(caseNode, filePath, seenStepIds, scope, errors)
    branchSummaries.push(summary)
  }

  const anyExports = branchSummaries.some((summary) => summary.exportShape.kind !== "none")
  if (anyExports && !seenElse) {
    errors.push(
      createCompileDiagnostic(
        CompileDiagnosticCode.InvalidWorkflow,
        "`branch` without `else` cannot declare case `exports`",
        {
          filePath,
        },
      ),
    )
  }
  if (anyExports && branchSummaries.some((summary) => summary.exportShape.kind === "none")) {
    errors.push(
      createCompileDiagnostic(
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
        const merged = mergeResultShapes(branchResultShape, shape)
        if (!areResultShapesCompatible(branchResultShape, shape)) {
          errors.push(
            createCompileDiagnostic(
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
  step: ParallelNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const branchIds = new Set<string>()
  const branchSummaries: ValidationSummary[] = []
  const mergedStepShapes = new Map(scope.availableStepShapes)

  for (const [index, branch] of step.branches.entries()) {
    const identifierError = validateIdentifier(branch.id, "parallel branch id", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    } else if (branchIds.has(branch.id)) {
      errors.push(
        createCompileDiagnostic(
          CompileDiagnosticCode.InvalidWorkflow,
          `\`branches[${index}]\` reuses local branch id \`${branch.id}\` within the same parallel node`,
          { filePath },
        ),
      )
    } else {
      branchIds.add(branch.id)
    }

    const summary = validateStepList(branch.steps, filePath, seenStepIds, scope, errors)
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
  caseNode: BranchCase,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ValidationSummary & { exportShape: ResultShape } {
  if (caseNode.if !== undefined) {
    validateExpressionTemplate(caseNode.if, filePath, scope, errors, "bool")
  }

  const summary = validateStepList(caseNode.steps, filePath, seenStepIds, scope, errors)
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
  if (step.with.action === "review") {
    if (step.with.review.target.type === "base") {
      validateTemplate(step.with.review.target.branch, filePath, scope, errors)
    }
    if (step.with.review.target.type === "commit") {
      validateTemplate(step.with.review.target.sha, filePath, scope, errors)
    }

    const reviewShape = shapeFromSchema(codexReviewOutputDefinition())
    return {
      availableStepShapes: new Map(scope.availableStepShapes),
      guaranteedResultShape: reviewShape,
      resultShape: reviewShape,
    }
  }

  validateTemplate(step.with.prompt, filePath, scope, errors)
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
    validateExpressionTemplate(step.if, filePath, scope, errors, "bool")
  }

  for (const value of Object.values(step.env ?? {})) {
    validateTemplate(value, filePath, scope, errors)
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
    const identifierError = validateIdentifier(key, "export name", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    }
    fields[key] = inferWrappedTemplateShape(template, filePath, scope, errors)
  }
  return { kind: "object", fields }
}

function inferWrappedTemplateShape(
  template: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ResultShape {
  const compiled = validateWrappedExpressionTemplate(template, filePath, scope, errors)
  return compiled === undefined
    ? AnyJsonShape
    : inferExpressionResultShape(compiled, (reference) => resolvePathShape(reference, scope))
}

function validateTemplate(template: string, filePath: string, scope: VisibleScope, errors: CompileDiagnostic[]): void {
  for (const expression of extractTemplateExpressions(template)) {
    validateExpression(expression, filePath, scope, errors)
  }
}

function validateExpressionTemplate(
  template: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  expected: "bool" | null = null,
): void {
  validateWrappedExpressionTemplate(template, filePath, scope, errors, expected)
}

function validateWrappedExpressionTemplate(
  template: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  expected: "bool" | null = null,
): CompiledExpression | undefined {
  if (!isWholeExpressionTemplate(template)) {
    errors.push(
      createCompileDiagnostic(CompileDiagnosticCode.InvalidExpression, "Expected a whole `${{ ... }}` expression.", {
        filePath,
      }),
    )
    for (const expression of extractTemplateExpressions(template)) {
      validateExpression(expression, filePath, scope, errors, expected)
    }
    return undefined
  }

  const [expression] = extractTemplateExpressions(template)
  if (expression === undefined) {
    errors.push(
      createCompileDiagnostic(CompileDiagnosticCode.InvalidExpression, "Expected a whole `${{ ... }}` expression.", {
        filePath,
      }),
    )
    return undefined
  }

  return validateExpression(expression, filePath, scope, errors, expected)
}

function validateExpression(
  expression: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  expected: "bool" | null = null,
): CompiledExpression | undefined {
  let compiled: CompiledExpression
  try {
    compiled = compileExpression(expression, expected)
  } catch (error) {
    const cause = normalizeError(error)
    errors.push(createCompileDiagnostic(CompileDiagnosticCode.InvalidExpression, cause.message, { filePath, cause }))
    return undefined
  }

  for (const reference of compiled.pathReferences) {
    const message = validateReference(reference, scope)
    if (message !== undefined) {
      errors.push(createCompileDiagnostic(CompileDiagnosticCode.ReferenceError, message, { filePath }))
    }
  }

  return compiled
}

function resolvePathShape(reference: PathReference, scope: VisibleScope): ResultShape {
  if (reference.root === "inputs") {
    const [inputName, ...rest] = reference.segments
    if (inputName === undefined) {
      return AnyJsonShape
    }
    const schema = scope.inputDefinitions[inputName]
    if (schema === undefined) {
      return AnyJsonShape
    }
    const resolved = resolveInputPathShape(schema, `inputs.${inputName}`, rest)
    return resolved.kind === "ok" ? resolved.shape : AnyJsonShape
  }

  if (reference.root === "steps") {
    const [stepId, ...rest] = reference.segments
    if (stepId === undefined) {
      return AnyJsonShape
    }

    let shape = scope.availableStepShapes.get(stepId) ?? AnyJsonShape
    const segments = rest[0] === "result" ? rest.slice(1) : []
    for (const segment of segments) {
      shape = descendResultShape(shape, segment)
    }
    return shape
  }

  if (reference.root === "run") {
    const [field] = reference.segments
    return field === "iteration" || field === "max_iterations" ? IntegerShape : StringShape
  }

  return AnyJsonShape
}

function validateReference(reference: PathReference, scope: VisibleScope): string | undefined {
  if (reference.root === "inputs") {
    const [inputName, ...rest] = reference.segments
    if (inputName === undefined) {
      return "`inputs` must reference a declared field"
    }
    const schema = scope.inputDefinitions[inputName]
    if (schema === undefined) {
      return `\`inputs.${inputName}\` is not declared by the workflow`
    }
    const resolved = resolveInputPathShape(schema, `inputs.${inputName}`, rest)
    return resolved.kind === "error" ? resolved.message : undefined
  }

  if (reference.root === "run") {
    if (!scope.insideLoop) {
      return "`run.*` is only available inside loops."
    }
    const [field, ...rest] = reference.segments
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

  if (reference.root === "steps") {
    const [stepId, access, ...rest] = reference.segments
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
