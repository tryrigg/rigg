import {
  AnyJsonShape,
  BooleanShape,
  IntegerShape,
  NullShape,
  NumberShape,
  StringShape,
  compileExpression,
  extractTemplateExpressions,
  inferExpressionResultShape,
  isWholeExpressionTemplate,
  mergeResultShapes,
  renderTemplate,
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
  WorkflowNode,
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
  validateInputValue,
} from "./schema"
import { workflowById, type WorkflowProject } from "./project"
import { normalizeError } from "../util/error"
import { tryParseJson } from "../util/json"

type VisibleScope = {
  availableStepShapes: Map<string, ResultShape>
  inputDefinitions: Record<string, InputDefinition>
  insideLoop: boolean
}

type ValidationSummary = {
  availableStepShapes: Map<string, ResultShape>
  guaranteedResultShape?: ResultShape | undefined
}

type WorkflowValidationSummary = {
  inputDefinitions: Record<string, InputDefinition>
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

function validateWorkflowStep(
  project: WorkflowProject,
  workflowId: string,
  step: WorkflowNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  activeWorkflowIds: string[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const referenceExpressions = extractTemplateExpressions(step.with.workflow)
  if (referenceExpressions.length > 0) {
    errors.push(
      createCompileDiagnostic(
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
      createCompileDiagnostic(
        CompileDiagnosticCode.InvalidWorkflow,
        `Step \`${step.id ?? "<anonymous>"}\` references workflow \`${step.with.workflow}\` which does not exist. Available workflows: ${formatWorkflowList(project)}.`,
        { filePath },
      ),
    )

    return {
      availableStepShapes: new Map(scope.availableStepShapes),
      guaranteedResultShape: NullShape,
      resultShape: NullShape,
    }
  }

  const targetSummary: WorkflowValidationSummary = {
    inputDefinitions: targetWorkflow.inputs ?? {},
  }

  if (activeWorkflowIds.includes(targetWorkflow.id)) {
    errors.push(
      createCompileDiagnostic(
        CompileDiagnosticCode.InvalidWorkflow,
        `Step \`${step.id ?? "<anonymous>"}\` creates a circular workflow reference: ${formatWorkflowCycle([
          ...activeWorkflowIds,
          targetWorkflow.id,
        ])}.`,
        { filePath },
      ),
    )
  } else {
    validateWorkflowReferenceGraph(project, targetWorkflow, [...activeWorkflowIds, targetWorkflow.id], errors)
  }

  validateWorkflowInputs(step, targetSummary, filePath, scope, errors)

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
    validateExpressionTemplate(caseNode.if, filePath, scope, errors, "bool")
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

function validateWorkflowReferenceGraph(
  project: WorkflowProject,
  workflow: WorkflowDocument,
  activeWorkflowIds: string[],
  errors: CompileDiagnostic[],
): void {
  const filePath = workflowFilePath(project, workflow.id)
  if (filePath === undefined) {
    return
  }

  walkWorkflowReferences(workflow.steps, (step) => {
    const referenceExpressions = extractTemplateExpressions(step.with.workflow)
    if (referenceExpressions.length > 0) {
      return
    }

    const targetWorkflow = workflowById(project, step.with.workflow)
    if (targetWorkflow === undefined) {
      return
    }

    if (activeWorkflowIds.includes(targetWorkflow.id)) {
      errors.push(
        createCompileDiagnostic(
          CompileDiagnosticCode.InvalidWorkflow,
          `Step \`${step.id ?? "<anonymous>"}\` creates a circular workflow reference: ${formatWorkflowCycle([
            ...activeWorkflowIds,
            targetWorkflow.id,
          ])}.`,
          { filePath },
        ),
      )
      return
    }

    validateWorkflowReferenceGraph(project, targetWorkflow, [...activeWorkflowIds, targetWorkflow.id], errors)
  })
}

function walkWorkflowReferences(steps: WorkflowStep[], visit: (step: WorkflowNode) => void): void {
  for (const step of steps) {
    switch (step.type) {
      case "workflow":
        visit(step)
        break
      case "group":
      case "loop":
        walkWorkflowReferences(step.steps, visit)
        break
      case "branch":
        for (const caseNode of step.cases) {
          walkWorkflowReferences(caseNode.steps, visit)
        }
        break
      case "parallel":
        for (const branch of step.branches) {
          walkWorkflowReferences(branch.steps, visit)
        }
        break
      case "shell":
      case "codex":
      case "write_file":
        break
    }
  }
}

function validateWorkflowInputs(
  step: WorkflowNode,
  workflow: WorkflowValidationSummary,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): void {
  const providedInputs = step.with.inputs ?? {}
  const declaredInputs = workflow.inputDefinitions
  const declaredInputNames = Object.keys(declaredInputs).sort()

  for (const [key, value] of Object.entries(providedInputs)) {
    const schema = declaredInputs[key]
    if (schema === undefined) {
      errors.push(
        createCompileDiagnostic(
          CompileDiagnosticCode.InvalidWorkflow,
          `Step \`${step.id ?? "<anonymous>"}\` provides input \`${key}\` which is not declared by workflow \`${step.with.workflow}\`. Declared inputs: ${formatIdentifierList(declaredInputNames)}.`,
          { filePath },
        ),
      )
      continue
    }

    validateWorkflowInputValue(step, key, value, schema, filePath, scope, errors)
  }

  for (const [key, schema] of Object.entries(declaredInputs)) {
    if (key in providedInputs || schema.default !== undefined) {
      continue
    }

    errors.push(
      createCompileDiagnostic(
        CompileDiagnosticCode.InvalidWorkflow,
        `Step \`${step.id ?? "<anonymous>"}\` does not provide required input \`${key}\` for workflow \`${step.with.workflow}\`.`,
        { filePath },
      ),
    )
  }
}

function validateWorkflowInputValue(
  step: WorkflowNode,
  key: string,
  value: unknown,
  schema: InputDefinition,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): void {
  const path = `Step \`${step.id ?? "<anonymous>"}\` input \`${key}\` for workflow \`${step.with.workflow}\``

  if (typeof value !== "string") {
    for (const message of validateInputValue(schema, value, path)) {
      errors.push(createCompileDiagnostic(CompileDiagnosticCode.InvalidWorkflow, message, { filePath }))
    }
    return
  }

  const expressions = extractTemplateExpressions(value)
  if (expressions.length === 0) {
    const normalizedValue = normalizeWorkflowLiteralInput(schema, value)
    for (const message of validateInputValue(schema, normalizedValue, path)) {
      errors.push(createCompileDiagnostic(CompileDiagnosticCode.InvalidWorkflow, message, { filePath }))
    }
    return
  }

  if (schema.type !== "string" && !isWholeExpressionTemplate(value)) {
    validateInterpolatedWorkflowInputValue(value, schema, path, filePath, scope, errors)
    return
  }

  validateTemplate(value, filePath, scope, errors)

  const providedShape = inferWorkflowInputShape(value, filePath, scope, errors)
  if (!isWorkflowInputShapeCompatible(providedShape, schema)) {
    errors.push(
      createCompileDiagnostic(
        CompileDiagnosticCode.InvalidWorkflow,
        `${path} expects a ${schema.type} value, but the provided template resolves to ${describeResultShape(providedShape)}.`,
        { filePath },
      ),
    )
  }
}

function validateInterpolatedWorkflowInputValue(
  template: string,
  schema: InputDefinition,
  path: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): void {
  const compiledExpressions = extractTemplateExpressions(template)
    .map((expression) => validateExpression(expression, filePath, scope, errors, "scalar"))
    .filter((compiled): compiled is CompiledExpression => compiled !== undefined)

  if (compiledExpressions.length === 0) {
    return
  }

  if (compiledExpressions.some((compiled) => compiled.pathReferences.length > 0)) {
    errors.push(
      createCompileDiagnostic(
        CompileDiagnosticCode.InvalidWorkflow,
        `${path} expects a ${schema.type} value, but mixed templates with dynamic expressions can only guarantee string output. Use a whole \`${"${{ ... }}"}\` expression instead.`,
        { filePath },
      ),
    )
    return
  }

  let renderedValue: unknown
  try {
    renderedValue = renderTemplate(template, { env: {}, inputs: {}, run: {}, steps: {} })
  } catch (error) {
    const cause = normalizeError(error)
    errors.push(createCompileDiagnostic(CompileDiagnosticCode.InvalidExpression, cause.message, { filePath, cause }))
    return
  }

  const normalizedValue =
    typeof renderedValue === "string" ? normalizeWorkflowLiteralInput(schema, renderedValue) : renderedValue

  for (const message of validateInputValue(schema, normalizedValue, path)) {
    errors.push(createCompileDiagnostic(CompileDiagnosticCode.InvalidWorkflow, message, { filePath }))
  }
}

function inferWorkflowInputShape(
  template: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
): ResultShape {
  if (!isWholeExpressionTemplate(template)) {
    return AnyJsonShape
  }

  const compiled = validateWrappedExpressionTemplate(template, filePath, scope, errors)
  return compiled === undefined
    ? AnyJsonShape
    : inferExpressionResultShape(compiled, (reference) => resolvePathShape(reference, scope))
}

function isWorkflowInputShapeCompatible(provided: ResultShape, schema: InputDefinition): boolean {
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
      return isWorkflowInputShapeCompatible(provided.items, schema.items)
    case "object":
      if (provided.kind !== "object") {
        return false
      }

      for (const key of schema.required ?? []) {
        if (!(key in provided.fields)) {
          return false
        }
      }

      for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
        const propertyShape = provided.fields[key]
        if (propertyShape !== undefined && !isWorkflowInputShapeCompatible(propertyShape, propertySchema)) {
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

function normalizeWorkflowLiteralInput(schema: InputDefinition, value: string): unknown {
  if (schema.type === "string") {
    return value
  }

  const parsedValue = tryParseJson(value)
  return parsedValue === undefined || parsedValue === null ? value : parsedValue
}

function workflowFilePath(project: WorkflowProject, workflowId: string): string | undefined {
  return project.files.find((file) => file.workflow.id === workflowId)?.filePath
}

function formatWorkflowList(project: WorkflowProject): string {
  return formatIdentifierList(project.files.map((file) => file.workflow.id).sort())
}

function formatIdentifierList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)"
}

function formatWorkflowCycle(workflowIds: string[]): string {
  return workflowIds.join(" -> ")
}

function describeResultShape(shape: ResultShape): string {
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
  expected: "bool" | "scalar" | null = null,
): void {
  validateWrappedExpressionTemplate(template, filePath, scope, errors, expected)
}

function validateWrappedExpressionTemplate(
  template: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileDiagnostic[],
  expected: "bool" | "scalar" | null = null,
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
  expected: "bool" | "scalar" | null = null,
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
