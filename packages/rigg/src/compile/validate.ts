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
import { createCompileError, CompileErrorCode, type CompileError } from "./diagnostics"
import type {
  ActionNode,
  BranchCase,
  BranchNode,
  ClaudeNode,
  CodexNode,
  GroupNode,
  InputDefinition,
  LoopNode,
  ParallelNode,
  WorkflowDocument,
  WorkflowStep,
} from "./schema"
import {
  codexReviewOutputDefinition,
  shapeFromSchema,
  resolveInputPathShape,
  validateIdentifier,
  validateInputDefinitions,
  validateOutputDefinition,
} from "./schema"
import type { WorkflowProject } from "./project"
import { normalizeError } from "../util/error"
import { deepEqual } from "../util/json"

type VisibleScope = {
  availableStepShapes: Map<string, ResultShape>
  conversationProviders: Map<string, "claude" | "codex">
  currentLoopPath?: string | undefined
  inputDefinitions: Record<string, InputDefinition>
  insideLoop: boolean
  possibleCodexConversations: Set<string>
}

type ValidationSummary = {
  allConversationBindings: Set<string>
  availableStepShapes: Map<string, ResultShape>
  guaranteedResultShape?: ResultShape | undefined
  possibleCodexConversations: Set<string>
}

export function validateWorkspace(project: WorkflowProject): CompileError[] {
  const errors: CompileError[] = []
  const seenWorkflowIds = new Set<string>()

  for (const file of project.files) {
    if (seenWorkflowIds.has(file.workflow.id)) {
      errors.push(
        createCompileError(CompileErrorCode.DuplicateWorkflowId, `Duplicate workflow id \`${file.workflow.id}\`.`, {
          filePath: file.filePath,
        }),
      )
      continue
    }

    seenWorkflowIds.add(file.workflow.id)
    errors.push(...validateWorkflow(file.workflow, file.filePath))
  }

  return errors
}

function validateWorkflow(workflow: WorkflowDocument, filePath: string): CompileError[] {
  const errors: CompileError[] = []
  const seenStepIds = new Set<string>()
  const rootScope: VisibleScope = {
    availableStepShapes: new Map(),
    conversationProviders: new Map(),
    inputDefinitions: workflow.inputs ?? {},
    insideLoop: false,
    possibleCodexConversations: new Set(),
  }

  for (const key of Object.keys(workflow.inputs ?? {})) {
    const identifierError = validateIdentifier(key, "input name", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    }
  }

  errors.push(
    ...validateInputDefinitions(workflow.inputs ?? {}).map((message) =>
      createCompileError(CompileErrorCode.InvalidWorkflow, message, { filePath }),
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
  errors: CompileError[],
): ValidationSummary {
  const availableStepShapes = new Map(scope.availableStepShapes)
  const possibleCodexConversations = new Set(scope.possibleCodexConversations)
  const allConversationBindings = new Set<string>()

  for (const step of steps) {
    const result = validateStep(
      step,
      filePath,
      seenStepIds,
      {
        availableStepShapes,
        conversationProviders: scope.conversationProviders,
        currentLoopPath: scope.currentLoopPath,
        inputDefinitions: scope.inputDefinitions,
        insideLoop: scope.insideLoop,
        possibleCodexConversations,
      },
      errors,
    )

    for (const binding of result.allConversationBindings) {
      allConversationBindings.add(binding)
    }

    if (step.id !== undefined) {
      availableStepShapes.set(step.id, result.guaranteedResultShape ?? result.resultShape)
    }

    for (const key of result.possibleCodexConversations) {
      possibleCodexConversations.add(key)
    }
  }

  return {
    allConversationBindings,
    availableStepShapes,
    possibleCodexConversations,
  }
}

function validateStep(
  step: WorkflowStep,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileError[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  if (step.id !== undefined) {
    const identifierError = validateIdentifier(step.id, "step id", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    } else if (seenStepIds.has(step.id)) {
      errors.push(
        createCompileError(CompileErrorCode.InvalidWorkflow, `Duplicate step id \`${step.id}\`.`, {
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
      case "claude":
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
  errors: CompileError[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  switch (step.type) {
    case "shell":
      validateTemplate(step.with.command, filePath, scope, errors)
      return {
        allConversationBindings: new Set(),
        availableStepShapes: new Map(scope.availableStepShapes),
        guaranteedResultShape:
          step.with.result === "none" ? { kind: "none" } : step.with.result === "json" ? AnyJsonShape : StringShape,
        possibleCodexConversations: new Set(scope.possibleCodexConversations),
        resultShape:
          step.with.result === "none" ? { kind: "none" } : step.with.result === "json" ? AnyJsonShape : StringShape,
      }
    case "write_file":
      validateTemplate(step.with.path, filePath, scope, errors)
      validateTemplate(step.with.content, filePath, scope, errors)
      return {
        allConversationBindings: new Set(),
        availableStepShapes: new Map(scope.availableStepShapes),
        guaranteedResultShape: { kind: "object", fields: { path: StringShape } },
        possibleCodexConversations: new Set(scope.possibleCodexConversations),
        resultShape: { kind: "object", fields: { path: StringShape } },
      }
    case "claude":
      return validateClaude(step, filePath, scope, errors)
    case "codex":
      return validateCodex(step, filePath, scope, errors)
  }
}

function validateGroupStep(
  step: GroupNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileError[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const inner = validateStepList(step.steps, filePath, seenStepIds, scope, errors)
  const resultShape = validateExports(
    step.exports,
    filePath,
    {
      ...scope,
      availableStepShapes: inner.availableStepShapes,
      possibleCodexConversations: inner.possibleCodexConversations,
    },
    errors,
  )

  return {
    allConversationBindings: inner.allConversationBindings,
    availableStepShapes: inner.availableStepShapes,
    guaranteedResultShape: resultShape,
    possibleCodexConversations: inner.possibleCodexConversations,
    resultShape,
  }
}

function validateLoopStep(
  step: LoopNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileError[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const loopScope = {
    ...scope,
    currentLoopPath: step.id ?? `loop@${seenStepIds.size}`,
    insideLoop: true,
  }
  const inner = validateStepList(step.steps, filePath, seenStepIds, loopScope, errors)
  validateExpressionTemplate(
    step.until,
    filePath,
    {
      ...loopScope,
      availableStepShapes: inner.availableStepShapes,
      possibleCodexConversations: inner.possibleCodexConversations,
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
      possibleCodexConversations: inner.possibleCodexConversations,
    },
    errors,
  )

  return {
    allConversationBindings: inner.allConversationBindings,
    availableStepShapes: inner.availableStepShapes,
    guaranteedResultShape: resultShape,
    possibleCodexConversations: filterConversationsAfterLoop(
      inner.possibleCodexConversations,
      loopScope.currentLoopPath,
    ),
    resultShape,
  }
}

function validateBranchStep(
  step: BranchNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileError[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  let seenElse = false
  const branchSummaries: Array<ValidationSummary & { exportShape: ResultShape }> = []

  for (const [index, caseNode] of step.cases.entries()) {
    const isElse = caseNode.else === true
    if (isElse && caseNode.if !== undefined) {
      errors.push(
        createCompileError(
          CompileErrorCode.InvalidWorkflow,
          `\`cases[${index}]\` cannot set both \`else\` and \`if\``,
          { filePath },
        ),
      )
    }
    if (!isElse && caseNode.if === undefined) {
      errors.push(
        createCompileError(
          CompileErrorCode.InvalidWorkflow,
          `\`cases[${index}]\` must define \`if\` unless it is an \`else\` case`,
          { filePath },
        ),
      )
    }
    if (isElse && index !== step.cases.length - 1) {
      errors.push(
        createCompileError(CompileErrorCode.InvalidWorkflow, "`else` case must be the last branch case", { filePath }),
      )
    }
    if (isElse) {
      if (seenElse) {
        errors.push(
          createCompileError(CompileErrorCode.InvalidWorkflow, "`branch` may define at most one `else` case", {
            filePath,
          }),
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
      createCompileError(CompileErrorCode.InvalidWorkflow, "`branch` without `else` cannot declare case `exports`", {
        filePath,
      }),
    )
  }
  if (anyExports && branchSummaries.some((summary) => summary.exportShape.kind === "none")) {
    errors.push(
      createCompileError(
        CompileErrorCode.InvalidWorkflow,
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
        if (!isBranchExportShapeCompatible(branchResultShape, shape)) {
          errors.push(
            createCompileError(
              CompileErrorCode.InvalidWorkflow,
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
    allConversationBindings: unionSets(branchSummaries.map((summary) => summary.allConversationBindings)),
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape: branchResultShape,
    possibleCodexConversations: unionSets(
      branchSummaries.map((summary) => summary.possibleCodexConversations),
      scope.possibleCodexConversations,
    ),
    resultShape: branchResultShape,
  }
}

function validateParallelStep(
  step: ParallelNode,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileError[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  const branchIds = new Set<string>()
  const branchSummaries: ValidationSummary[] = []
  const mergedStepShapes = new Map(scope.availableStepShapes)
  const seenBranchConversations = new Set<string>()

  for (const [index, branch] of step.branches.entries()) {
    const identifierError = validateIdentifier(branch.id, "parallel branch id", filePath)
    if (identifierError !== undefined) {
      errors.push(identifierError)
    } else if (branchIds.has(branch.id)) {
      errors.push(
        createCompileError(
          CompileErrorCode.InvalidWorkflow,
          `\`branches[${index}]\` reuses local branch id \`${branch.id}\` within the same parallel node`,
          { filePath },
        ),
      )
    } else {
      branchIds.add(branch.id)
    }

    const summary = validateStepList(branch.steps, filePath, seenStepIds, scope, errors)
    for (const binding of summary.allConversationBindings) {
      if (seenBranchConversations.has(binding)) {
        errors.push(
          createCompileError(
            CompileErrorCode.InvalidWorkflow,
            `\`branches[${index}]\` (\`${branch.id}\`) cannot reuse a conversation binding already used by a sibling parallel branch`,
            { filePath },
          ),
        )
      }
      seenBranchConversations.add(binding)
    }

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
      possibleCodexConversations: unionSets(
        branchSummaries.map((summary) => summary.possibleCodexConversations),
        scope.possibleCodexConversations,
      ),
    },
    errors,
  )

  return {
    allConversationBindings: unionSets(branchSummaries.map((summary) => summary.allConversationBindings)),
    availableStepShapes: mergedStepShapes,
    guaranteedResultShape: resultShape,
    possibleCodexConversations: unionSets(
      branchSummaries.map((summary) => summary.possibleCodexConversations),
      scope.possibleCodexConversations,
    ),
    resultShape,
  }
}

function validateBranchCase(
  caseNode: BranchCase,
  filePath: string,
  seenStepIds: Set<string>,
  scope: VisibleScope,
  errors: CompileError[],
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
      possibleCodexConversations: summary.possibleCodexConversations,
    },
    errors,
  )

  return { ...summary, exportShape }
}

function validateClaude(
  step: ClaudeNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileError[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  validateTemplate(step.with.prompt, filePath, scope, errors)
  for (const addDir of step.with.add_dirs ?? []) {
    validateTemplate(addDir, filePath, scope, errors)
  }
  const conversationKey = validateConversation(
    "claude",
    step.with.conversation,
    step.with.persist,
    filePath,
    scope,
    errors,
  )
  if (step.with.output_schema !== undefined && step.with.output_schema.type !== "object") {
    errors.push(
      createCompileError(CompileErrorCode.InvalidWorkflow, "Claude `output_schema` must use `type: object`.", {
        filePath,
      }),
    )
  }
  if (step.with.output_schema !== undefined) {
    for (const message of validateOutputDefinition(step.with.output_schema, "with.output_schema")) {
      errors.push(createCompileError(CompileErrorCode.InvalidWorkflow, message, { filePath }))
    }
  }

  return {
    allConversationBindings: conversationKey === undefined ? new Set() : new Set([conversationKey]),
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape:
      step.with.output_schema === undefined ? StringShape : shapeFromSchema(step.with.output_schema),
    possibleCodexConversations: new Set(scope.possibleCodexConversations),
    resultShape: step.with.output_schema === undefined ? StringShape : shapeFromSchema(step.with.output_schema),
  }
}

function validateCodex(
  step: CodexNode,
  filePath: string,
  scope: VisibleScope,
  errors: CompileError[],
): ValidationSummary & { guaranteedResultShape: ResultShape; resultShape: ResultShape } {
  if (step.with.action === "review") {
    if (step.with.base !== undefined) {
      validateTemplate(step.with.base, filePath, scope, errors)
    }
    if (step.with.commit !== undefined) {
      validateTemplate(step.with.commit, filePath, scope, errors)
    }
    if (step.with.prompt !== undefined) {
      validateTemplate(step.with.prompt, filePath, scope, errors)
    }
    if (step.with.title !== undefined) {
      validateTemplate(step.with.title, filePath, scope, errors)
    }
    for (const addDir of step.with.add_dirs ?? []) {
      validateTemplate(addDir, filePath, scope, errors)
    }

    const target = inferCodexReviewTarget(step.with.base, step.with.commit, step.with.target)
    if (target.kind === "invalid") {
      errors.push(createCompileError(CompileErrorCode.InvalidWorkflow, target.message, { filePath }))
    }

    return {
      allConversationBindings: new Set(),
      availableStepShapes: new Map(scope.availableStepShapes),
      guaranteedResultShape: shapeFromSchema(codexReviewOutputDefinition()),
      possibleCodexConversations: new Set(scope.possibleCodexConversations),
      resultShape: shapeFromSchema(codexReviewOutputDefinition()),
    }
  }

  validateTemplate(step.with.prompt, filePath, scope, errors)
  for (const addDir of step.with.add_dirs ?? []) {
    validateTemplate(addDir, filePath, scope, errors)
  }
  const conversationKey = validateConversation(
    "codex",
    step.with.conversation,
    step.with.persist,
    filePath,
    scope,
    errors,
  )
  if (step.with.output_schema !== undefined && step.with.output_schema.type !== "object") {
    errors.push(
      createCompileError(CompileErrorCode.InvalidWorkflow, "Codex exec `output_schema` must use `type: object`.", {
        filePath,
      }),
    )
  }
  if (step.with.output_schema !== undefined) {
    for (const message of validateOutputDefinition(step.with.output_schema, "with.output_schema")) {
      errors.push(createCompileError(CompileErrorCode.InvalidWorkflow, message, { filePath }))
    }
  }

  const possibleCodexConversations = new Set(scope.possibleCodexConversations)
  if (conversationKey !== undefined) {
    if (scope.possibleCodexConversations.has(conversationKey)) {
      if ((step.with.add_dirs?.length ?? 0) > 0) {
        errors.push(
          createCompileError(
            CompileErrorCode.InvalidWorkflow,
            "`conversation` may resume a previous Codex session, but `codex exec resume` does not support `with.add_dirs`",
            { filePath },
          ),
        )
      }
      if (step.with.output_schema !== undefined) {
        errors.push(
          createCompileError(
            CompileErrorCode.InvalidWorkflow,
            "`conversation` may resume a previous Codex session, but `codex exec resume` does not support `with.output_schema`",
            { filePath },
          ),
        )
      }
    }
    possibleCodexConversations.add(conversationKey)
  }

  return {
    allConversationBindings: conversationKey === undefined ? new Set() : new Set([conversationKey]),
    availableStepShapes: new Map(scope.availableStepShapes),
    guaranteedResultShape:
      step.with.output_schema === undefined ? StringShape : shapeFromSchema(step.with.output_schema),
    possibleCodexConversations,
    resultShape: step.with.output_schema === undefined ? StringShape : shapeFromSchema(step.with.output_schema),
  }
}

function validateConversation(
  provider: "claude" | "codex",
  conversation: { name: string; scope?: "iteration" | "loop" | "workflow" | undefined } | undefined,
  persist: boolean | undefined,
  filePath: string,
  scope: VisibleScope,
  errors: CompileError[],
): string | undefined {
  if (conversation === undefined) {
    return undefined
  }

  if (persist === false) {
    errors.push(
      createCompileError(
        CompileErrorCode.InvalidWorkflow,
        "`conversation` requires session persistence; remove `persist: false`",
        { filePath },
      ),
    )
  }

  const scopedKey = scopedConversationKey(conversation, scope)
  if (scopedKey === undefined) {
    errors.push(
      createCompileError(
        CompileErrorCode.InvalidWorkflow,
        `Conversation scope \`${conversation.scope}\` can only be used inside loops.`,
        { filePath },
      ),
    )
    return undefined
  }

  const existingProvider = scope.conversationProviders.get(scopedKey)
  if (existingProvider !== undefined && existingProvider !== provider) {
    errors.push(
      createCompileError(
        CompileErrorCode.InvalidWorkflow,
        `\`conversation: ${conversation.name}\` is already bound to \`${existingProvider}\` and cannot be reused by \`${provider}\``,
        { filePath },
      ),
    )
  } else if (existingProvider === undefined) {
    scope.conversationProviders.set(scopedKey, provider)
  }

  return scopedKey
}

function scopedConversationKey(
  conversation: { name: string; scope?: "iteration" | "loop" | "workflow" | undefined },
  scope: VisibleScope,
): string | undefined {
  const resolvedScope = conversation.scope ?? (scope.insideLoop ? "iteration" : "workflow")
  if (resolvedScope === "workflow") {
    return `workflow:${conversation.name}`
  }
  if (scope.currentLoopPath === undefined) {
    return undefined
  }
  return `${resolvedScope}:${scope.currentLoopPath}:${conversation.name}`
}

function filterConversationsAfterLoop(conversations: Set<string>, currentLoopPath: string | undefined): Set<string> {
  if (currentLoopPath === undefined) {
    return new Set(conversations)
  }
  return new Set(
    [...conversations].filter(
      (key) => !key.startsWith(`loop:${currentLoopPath}:`) && !key.startsWith(`iteration:${currentLoopPath}:`),
    ),
  )
}

function inferCodexReviewTarget(
  base: string | undefined,
  commit: string | undefined,
  target: "base" | "commit" | "uncommitted" | undefined,
): { kind: "ok" } | { kind: "invalid"; message: string } {
  if (target === "uncommitted" && base === undefined && commit === undefined) {
    return { kind: "ok" }
  }
  if (
    (target === "base" && base !== undefined && commit === undefined) ||
    (target === undefined && base !== undefined && commit === undefined)
  ) {
    return { kind: "ok" }
  }
  if (target === "commit" && commit !== undefined && base === undefined) {
    return { kind: "ok" }
  }
  return {
    kind: "invalid",
    message:
      "`review` requires exactly one of `target: uncommitted`, `target: base` with `base`, or `target: commit` with `commit`",
  }
}

function validateStepExpressions(
  step: WorkflowStep,
  filePath: string,
  scope: VisibleScope,
  errors: CompileError[],
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
  errors: CompileError[],
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
  errors: CompileError[],
): ResultShape {
  const compiled = validateWrappedExpressionTemplate(template, filePath, scope, errors)
  return compiled === undefined
    ? AnyJsonShape
    : inferExpressionResultShape(compiled, (reference) => resolvePathShape(reference, scope))
}

function validateTemplate(template: string, filePath: string, scope: VisibleScope, errors: CompileError[]): void {
  for (const expression of extractTemplateExpressions(template)) {
    validateExpression(expression, filePath, scope, errors)
  }
}

function validateExpressionTemplate(
  template: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileError[],
  expected: "bool" | null = null,
): void {
  validateWrappedExpressionTemplate(template, filePath, scope, errors, expected)
}

function validateWrappedExpressionTemplate(
  template: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileError[],
  expected: "bool" | null = null,
): CompiledExpression | undefined {
  if (!isWholeExpressionTemplate(template)) {
    errors.push(
      createCompileError(CompileErrorCode.InvalidExpression, "Expected a whole `${{ ... }}` expression.", { filePath }),
    )
    for (const expression of extractTemplateExpressions(template)) {
      validateExpression(expression, filePath, scope, errors, expected)
    }
    return undefined
  }

  const [expression] = extractTemplateExpressions(template)
  if (expression === undefined) {
    errors.push(
      createCompileError(CompileErrorCode.InvalidExpression, "Expected a whole `${{ ... }}` expression.", { filePath }),
    )
    return undefined
  }

  return validateExpression(expression, filePath, scope, errors, expected)
}

function validateExpression(
  expression: string,
  filePath: string,
  scope: VisibleScope,
  errors: CompileError[],
  expected: "bool" | null = null,
): CompiledExpression | undefined {
  let compiled: CompiledExpression
  try {
    compiled = compileExpression(expression, expected)
  } catch (error) {
    const cause = normalizeError(error)
    errors.push(createCompileError(CompileErrorCode.InvalidExpression, cause.message, { filePath, cause }))
    return undefined
  }

  for (const reference of compiled.pathReferences) {
    const message = validateReference(reference, scope)
    if (message !== undefined) {
      errors.push(createCompileError(CompileErrorCode.ReferenceError, message, { filePath }))
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
      shape = descendShape(shape, segment)
    }
    return shape
  }

  if (reference.root === "run") {
    const [field] = reference.segments
    return field === "iteration" || field === "max_iterations" ? IntegerShape : StringShape
  }

  return AnyJsonShape
}

function descendShape(shape: ResultShape, segment: string): ResultShape {
  if (shape.kind === "object") {
    return shape.fields[segment] ?? AnyJsonShape
  }
  if (shape.kind === "array") {
    return shape.items ?? AnyJsonShape
  }
  return AnyJsonShape
}

function isBranchExportShapeCompatible(left: ResultShape, right: ResultShape): boolean {
  if (deepEqual(left, right)) {
    return true
  }

  if ((left.kind === "integer" && right.kind === "number") || (left.kind === "number" && right.kind === "integer")) {
    return true
  }

  if (left.kind === "array" && right.kind === "array") {
    if (left.items === undefined || right.items === undefined) {
      return left.items === undefined && right.items === undefined
    }
    return isBranchExportShapeCompatible(left.items, right.items)
  }

  if (left.kind === "object" && right.kind === "object") {
    const leftKeys = Object.keys(left.fields)
    const rightKeys = Object.keys(right.fields)
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !(key in right.fields))) {
      return false
    }

    return leftKeys.every((key) =>
      isBranchExportShapeCompatible(left.fields[key] ?? AnyJsonShape, right.fields[key] ?? AnyJsonShape),
    )
  }

  return false
}

function unionSets<T>(sets: Iterable<Set<T>>, initial?: Set<T>): Set<T> {
  const result = new Set(initial ?? [])
  for (const set of sets) {
    for (const item of set) {
      result.add(item)
    }
  }
  return result
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
    return validateResultPath(stepId, shape, rest)
  }

  return undefined
}

function validateResultPath(stepId: string, shape: ResultShape, segments: string[]): string | undefined {
  if (segments.length === 0) {
    return shape.kind === "none" ? `\`steps.${stepId}.result\` is not available for this node` : undefined
  }

  switch (shape.kind) {
    case "none":
      return `\`steps.${stepId}.result\` is not available for this node`
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return `\`steps.${stepId}.result\` does not support nested field access`
    case "any_json":
      return undefined
    case "object": {
      const [segment, ...rest] = segments
      if (segment === undefined) {
        return undefined
      }
      const child = shape.fields[segment]
      if (child === undefined) {
        return `\`steps.${stepId}.result.${segment}\` is not declared`
      }
      return validateResultPath(stepId, child, rest)
    }
    case "array": {
      const [segment, ...rest] = segments
      if (segment === undefined) {
        return undefined
      }
      if (!/^\d+$/.test(segment)) {
        return `\`steps.${stepId}.result\` array access must use a numeric index`
      }
      return shape.items === undefined ? undefined : validateResultPath(stepId, shape.items, rest)
    }
  }
}
