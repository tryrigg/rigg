import { asJsonValue, isJsonObject, parseJson, type JsonValue } from "../util/json"
import { AnyJsonShape, BooleanShape, IntegerShape, StringShape, shapeFromJson, type ResultShape } from "./shape"

export const TEMPLATE_PATTERN = /\$\{\{\s*([\s\S]*?)\s*\}\}/g

export const ExprRoot = {
  Env: "env",
  Inputs: "inputs",
  Run: "run",
  Steps: "steps",
} as const

export type ExprRoot = (typeof ExprRoot)[keyof typeof ExprRoot]

export type PathReference = {
  root: ExprRoot
  segments: string[]
}

export type EvalContext = {
  env: Record<string, string | undefined>
  inputs: Record<string, unknown>
  run: Record<string, unknown>
  steps: Record<string, { result: unknown; status: string }>
}

type Token =
  | { kind: "and" }
  | { kind: "boolean"; value: boolean }
  | { kind: "comma" }
  | { kind: "dot" }
  | { kind: "end" }
  | { kind: "eq" }
  | { kind: "gt" }
  | { kind: "gte" }
  | { kind: "identifier"; value: string }
  | { kind: "left_paren" }
  | { kind: "lt" }
  | { kind: "lte" }
  | { kind: "not" }
  | { kind: "not_eq" }
  | { kind: "null" }
  | { kind: "number"; value: string }
  | { kind: "or" }
  | { kind: "right_paren" }
  | { kind: "string"; value: string }

type ExprNode =
  | { kind: "literal"; value: JsonValue }
  | { kind: "path"; root: ExprRoot; segments: string[] }
  | { kind: "not"; inner: ExprNode }
  | {
      kind: "binary"
      left: ExprNode
      op: "and" | "eq" | "gt" | "gte" | "lt" | "lte" | "not_eq" | "or"
      right: ExprNode
    }
  | { kind: "call"; name: string; args: ExprNode[] }

export type CompiledExpression = {
  ast: ExprNode
  directPathReference?: PathReference | undefined
  expected: "bool" | "scalar" | null
  pathReferences: PathReference[]
  roots: Set<ExprRoot>
  source: string
}

export function extractExprs(template: string): string[] {
  return [...template.matchAll(TEMPLATE_PATTERN)].map((match) => match[1] ?? "")
}

export function isWholeTemplate(template: string): boolean {
  const trimmed = template.trim()
  const matches = [...trimmed.matchAll(TEMPLATE_PATTERN)]
  return matches.length === 1 && matches[0]?.[0] === trimmed
}

function unwrapWholeTemplate(template: string): string | undefined {
  const expressions = extractExprs(template.trim())
  return isWholeTemplate(template) ? expressions[0] : undefined
}

export function compile(source: string, expected: "bool" | "scalar" | null = null): CompiledExpression {
  const tokens = tokenize(source)
  const parsed = parseExpression(source, tokens)
  const roots = new Set<ExprRoot>()
  const pathReferences: PathReference[] = []
  collectMetadata(parsed, roots, pathReferences)
  validateFunctions(source, parsed)
  return {
    ast: parsed,
    directPathReference: parsed.kind === "path" ? { root: parsed.root, segments: [...parsed.segments] } : undefined,
    expected,
    pathReferences,
    roots,
    source,
  }
}

function evaluateCompiledExpression(expression: CompiledExpression, context: EvalContext): unknown {
  const value = evaluateNode(expression.ast, toJsonContext(context), expression.source)

  if (expression.expected === "bool") {
    if (typeof value !== "boolean") {
      throw new Error(`expression \`${expression.source}\` evaluated to non-boolean value`)
    }
    return value
  }

  if (expression.expected === "scalar") {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value === null ? "" : value
    }

    throw new Error(
      `expression \`${expression.source}\` evaluated to non-scalar template value; use toJSON(...) or join(...) to render arrays or objects`,
    )
  }

  return value
}

export function renderTemplate(template: string, context: EvalContext): unknown {
  const wholeExpression = unwrapWholeTemplate(template)
  if (wholeExpression !== undefined) {
    return evaluateCompiledExpression(compile(wholeExpression), context)
  }

  const rendered = parseTemplateSegments(template).map((segment) =>
    segment.kind === "text"
      ? segment.value
      : String(evaluateCompiledExpression(compile(segment.expression, "scalar"), context)),
  )

  return rendered.join("")
}

export function renderString(template: string, context: EvalContext): string {
  const value = renderTemplate(template, context)
  return stringifyValue(value)
}

export function inferExpressionResultShape(
  expression: CompiledExpression,
  resolvePath: (reference: PathReference) => ResultShape,
): ResultShape {
  return inferNodeShape(expression.ast, resolvePath)
}

function collectMetadata(node: ExprNode, roots: Set<ExprRoot>, pathReferences: PathReference[]): void {
  switch (node.kind) {
    case "literal":
      return
    case "path":
      roots.add(node.root)
      pathReferences.push({ root: node.root, segments: [...node.segments] })
      return
    case "not":
      collectMetadata(node.inner, roots, pathReferences)
      return
    case "binary":
      collectMetadata(node.left, roots, pathReferences)
      collectMetadata(node.right, roots, pathReferences)
      return
    case "call":
      for (const argument of node.args) {
        collectMetadata(argument, roots, pathReferences)
      }
  }
}

function validateFunctions(source: string, node: ExprNode): void {
  switch (node.kind) {
    case "literal":
    case "path":
      return
    case "not":
      validateFunctions(source, node.inner)
      return
    case "binary":
      validateFunctions(source, node.left)
      validateFunctions(source, node.right)
      return
    case "call":
      if (!SUPPORTED_FUNCTIONS.has(node.name)) {
        throw new Error(`expression \`${source}\` calls unsupported function \`${node.name}\``)
      }
      for (const argument of node.args) {
        validateFunctions(source, argument)
      }
  }
}

const SUPPORTED_FUNCTIONS = new Set([
  "contains",
  "endsWith",
  "format",
  "fromJSON",
  "join",
  "len",
  "startsWith",
  "toJSON",
])

function parseTemplateSegments(
  template: string,
): Array<{ kind: "text"; value: string } | { kind: "expr"; expression: string }> {
  const segments: Array<{ kind: "expr"; expression: string } | { kind: "text"; value: string }> = []
  let index = 0

  while (index < template.length) {
    const start = template.indexOf("${{", index)
    if (start < 0) {
      segments.push({ kind: "text", value: template.slice(index) })
      break
    }

    if (start > index) {
      segments.push({ kind: "text", value: template.slice(index, start) })
    }

    const end = template.indexOf("}}", start + 3)
    if (end < 0) {
      throw new Error(`template is missing closing \`}}\`: ${template}`)
    }

    segments.push({
      kind: "expr",
      expression: template.slice(start + 3, end).trim(),
    })
    index = end + 2
  }

  return segments
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0

  while (index < source.length) {
    const ch = source[index]
    if (ch === undefined) {
      break
    }

    if (/\s/u.test(ch)) {
      index += 1
      continue
    }

    if (ch === "(") {
      tokens.push({ kind: "left_paren" })
      index += 1
      continue
    }
    if (ch === ")") {
      tokens.push({ kind: "right_paren" })
      index += 1
      continue
    }
    if (ch === ",") {
      tokens.push({ kind: "comma" })
      index += 1
      continue
    }
    if (ch === ".") {
      tokens.push({ kind: "dot" })
      index += 1
      continue
    }
    if (ch === "!" && source[index + 1] === "=") {
      tokens.push({ kind: "not_eq" })
      index += 2
      continue
    }
    if (ch === "!") {
      tokens.push({ kind: "not" })
      index += 1
      continue
    }
    if (ch === "&" && source[index + 1] === "&") {
      tokens.push({ kind: "and" })
      index += 2
      continue
    }
    if (ch === "|" && source[index + 1] === "|") {
      tokens.push({ kind: "or" })
      index += 2
      continue
    }
    if (ch === "=" && source[index + 1] === "=") {
      tokens.push({ kind: "eq" })
      index += 2
      continue
    }
    if (ch === ">" && source[index + 1] === "=") {
      tokens.push({ kind: "gte" })
      index += 2
      continue
    }
    if (ch === "<" && source[index + 1] === "=") {
      tokens.push({ kind: "lte" })
      index += 2
      continue
    }
    if (ch === ">") {
      tokens.push({ kind: "gt" })
      index += 1
      continue
    }
    if (ch === "<") {
      tokens.push({ kind: "lt" })
      index += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      const { value, nextIndex } = readStringToken(source, index, ch)
      tokens.push({ kind: "string", value })
      index = nextIndex
      continue
    }
    if (ch === "-" || /\d/u.test(ch)) {
      const { value, nextIndex } = readNumberToken(source, index)
      tokens.push({ kind: "number", value })
      index = nextIndex
      continue
    }
    if (/[A-Za-z_]/u.test(ch)) {
      const { value, nextIndex } = readIdentifierToken(source, index)
      if (value === "true") {
        tokens.push({ kind: "boolean", value: true })
      } else if (value === "false") {
        tokens.push({ kind: "boolean", value: false })
      } else if (value === "null") {
        tokens.push({ kind: "null" })
      } else {
        tokens.push({ kind: "identifier", value })
      }
      index = nextIndex
      continue
    }

    throw new Error(`failed to parse expression \`${source}\`: unexpected character \`${ch}\` at byte ${index}`)
  }

  tokens.push({ kind: "end" })
  return tokens
}

function readStringToken(
  source: string,
  start: number,
  quote: string,
): {
  value: string
  nextIndex: number
} {
  let value = ""
  let index = start + 1

  while (index < source.length) {
    const ch = source[index]
    if (ch === undefined) {
      break
    }
    if (ch === quote) {
      return { value, nextIndex: index + 1 }
    }
    if (ch === "\\") {
      const escaped = source[index + 1]
      if (escaped === undefined) {
        break
      }
      value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped
      index += 2
      continue
    }
    value += ch
    index += 1
  }

  throw new Error(`failed to parse expression \`${source}\`: unterminated string literal at byte ${start}`)
}

function readNumberToken(
  source: string,
  start: number,
): {
  value: string
  nextIndex: number
} {
  let index = start
  let value = ""
  let seenDot = false

  while (index < source.length) {
    const ch = source[index]
    if (ch === undefined) {
      break
    }
    if (index === start && ch === "-") {
      value += ch
      index += 1
      continue
    }
    if (/\d/u.test(ch)) {
      value += ch
      index += 1
      continue
    }
    if (!seenDot && ch === "." && /\d/u.test(source[index + 1] ?? "")) {
      seenDot = true
      value += ch
      index += 1
      continue
    }
    break
  }

  return { value, nextIndex: index }
}

function readIdentifierToken(
  source: string,
  start: number,
): {
  value: string
  nextIndex: number
} {
  let index = start
  let value = ""
  while (index < source.length) {
    const ch = source[index]
    if (ch !== undefined && /[A-Za-z0-9_-]/u.test(ch)) {
      value += ch
      index += 1
      continue
    }
    break
  }
  return { value, nextIndex: index }
}

function parseExpression(source: string, tokens: Token[]): ExprNode {
  let index = 0

  function peek(): Token {
    return tokens[index] ?? { kind: "end" }
  }

  function advance(): Token {
    const token = peek()
    index += 1
    return token
  }

  function expect(kind: Token["kind"]): void {
    const token = advance()
    if (token.kind !== kind) {
      throw new Error(`failed to parse expression \`${source}\`: unexpected token`)
    }
  }

  function parseOr(): ExprNode {
    let node = parseAnd()
    while (peek().kind === "or") {
      advance()
      node = { kind: "binary", left: node, op: "or", right: parseAnd() }
    }
    return node
  }

  function parseAnd(): ExprNode {
    let node = parseComparison()
    while (peek().kind === "and") {
      advance()
      node = { kind: "binary", left: node, op: "and", right: parseComparison() }
    }
    return node
  }

  function parseComparison(): ExprNode {
    let node = parseUnary()
    while (true) {
      const token = peek()
      const op =
        token.kind === "eq"
          ? "eq"
          : token.kind === "not_eq"
            ? "not_eq"
            : token.kind === "gt"
              ? "gt"
              : token.kind === "gte"
                ? "gte"
                : token.kind === "lt"
                  ? "lt"
                  : token.kind === "lte"
                    ? "lte"
                    : undefined
      if (op === undefined) {
        break
      }
      advance()
      node = { kind: "binary", left: node, op, right: parseUnary() }
    }
    return node
  }

  function parseUnary(): ExprNode {
    if (peek().kind === "not") {
      advance()
      return { kind: "not", inner: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary(): ExprNode {
    const token = advance()
    switch (token.kind) {
      case "left_paren": {
        const node = parseOr()
        expect("right_paren")
        return node
      }
      case "string":
        return { kind: "literal", value: token.value }
      case "number":
        return { kind: "literal", value: parseNumericLiteral(source, token.value) }
      case "boolean":
        return { kind: "literal", value: token.value }
      case "null":
        return { kind: "literal", value: null }
      case "identifier":
        return parseIdentifier(token.value)
      default:
        throw new Error(`failed to parse expression \`${source}\`: expected a value`)
    }
  }

  function parseIdentifier(name: string): ExprNode {
    if (peek().kind === "left_paren") {
      advance()
      const args: ExprNode[] = []
      if (peek().kind !== "right_paren") {
        while (true) {
          args.push(parseOr())
          if (peek().kind !== "comma") {
            break
          }
          advance()
        }
      }
      expect("right_paren")
      return { kind: "call", name, args }
    }

    const root =
      name === "inputs"
        ? ExprRoot.Inputs
        : name === "env"
          ? ExprRoot.Env
          : name === "steps"
            ? ExprRoot.Steps
            : name === "run"
              ? ExprRoot.Run
              : undefined
    if (root === undefined) {
      throw new Error(`failed to parse expression \`${source}\`: unknown identifier \`${name}\``)
    }

    const segments: string[] = []
    while (peek().kind === "dot") {
      advance()
      const next = advance()
      if (next.kind === "identifier" || next.kind === "number") {
        segments.push(next.value)
        continue
      }
      throw new Error(`failed to parse expression \`${source}\`: expected a property name after \`.\``)
    }

    return { kind: "path", root, segments }
  }

  const parsed = parseOr()
  if (peek().kind !== "end") {
    throw new Error(`failed to parse expression \`${source}\`: unexpected token`)
  }
  return parsed
}

function parseNumericLiteral(source: string, raw: string): number {
  const parsed = Number(raw)
  if (Number.isNaN(parsed)) {
    throw new Error(`failed to parse expression \`${source}\`: invalid number literal \`${raw}\``)
  }
  return parsed
}

function toJsonContext(context: EvalContext): JsonValue {
  return {
    env: Object.fromEntries(Object.entries(context.env).map(([key, value]) => [key, value ?? null] as const)),
    inputs: toJsonValue(context.inputs),
    run: toJsonValue(context.run),
    steps: toJsonValue(context.steps),
  }
}

function toJsonValue(value: unknown): JsonValue {
  return asJsonValue(value) ?? null
}

function evaluateNode(node: ExprNode, context: JsonValue, source: string): unknown {
  switch (node.kind) {
    case "literal":
      return node.value
    case "path":
      return resolvePath(context, node.root, node.segments)
    case "not":
      return !truthy(evaluateNode(node.inner, context, source))
    case "binary":
      return evaluateBinary(node, context, source)
    case "call":
      return evaluateCall(node.name, node.args, context, source)
  }
}

function evaluateBinary(node: Extract<ExprNode, { kind: "binary" }>, context: JsonValue, source: string): boolean {
  if (node.op === "or") {
    return truthy(evaluateNode(node.left, context, source)) || truthy(evaluateNode(node.right, context, source))
  }
  if (node.op === "and") {
    return truthy(evaluateNode(node.left, context, source)) && truthy(evaluateNode(node.right, context, source))
  }

  const left = evaluateNode(node.left, context, source)
  const right = evaluateNode(node.right, context, source)
  const ordering = compareValues(left, right)

  switch (node.op) {
    case "eq":
      return ordering === 0
    case "not_eq":
      return ordering !== 0
    case "gt":
      return ordering > 0
    case "gte":
      return ordering >= 0
    case "lt":
      return ordering < 0
    case "lte":
      return ordering <= 0
    default:
      return false
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1
  }
  if (typeof left === "string" && typeof right === "string") {
    return compareCanonicalStrings(left, right)
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1
  }
  return compareCanonicalStrings(stableStringify(left), stableStringify(right))
}

function evaluateCall(name: string, args: ExprNode[], context: JsonValue, source: string): unknown {
  if (name === "contains") {
    ensureArity(name, args, 2)
    const haystack = evaluateNode(requiredArg(args, 0, name), context, source)
    const needle = evaluateNode(requiredArg(args, 1, name), context, source)
    if (typeof haystack === "string") {
      return haystack.includes(stringifyValue(needle))
    }
    if (Array.isArray(haystack)) {
      return haystack.some((item) => stableStringify(item) === stableStringify(needle))
    }
    return false
  }
  if (name === "startsWith") {
    ensureArity(name, args, 2)
    return stringifyValue(evaluateNode(requiredArg(args, 0, name), context, source)).startsWith(
      stringifyValue(evaluateNode(requiredArg(args, 1, name), context, source)),
    )
  }
  if (name === "endsWith") {
    ensureArity(name, args, 2)
    return stringifyValue(evaluateNode(requiredArg(args, 0, name), context, source)).endsWith(
      stringifyValue(evaluateNode(requiredArg(args, 1, name), context, source)),
    )
  }
  if (name === "format") {
    if (args.length === 0) {
      throw new Error("format expects at least one argument")
    }
    let rendered = stringifyValue(evaluateNode(requiredArg(args, 0, name), context, source))
    for (const [index, arg] of args.slice(1).entries()) {
      rendered = rendered.replaceAll(`{${index}}`, stringifyValue(evaluateNode(arg, context, source)))
    }
    return rendered
  }
  if (name === "join") {
    ensureArity(name, args, 2)
    const values = evaluateNode(requiredArg(args, 0, name), context, source)
    const separator = stringifyValue(evaluateNode(requiredArg(args, 1, name), context, source))
    if (!Array.isArray(values)) {
      throw new Error("join expects an array as the first argument")
    }
    return values.map((item) => stringifyValue(item)).join(separator)
  }
  if (name === "toJSON") {
    ensureArity(name, args, 1)
    return stableStringify(evaluateNode(requiredArg(args, 0, name), context, source))
  }
  if (name === "fromJSON") {
    ensureArity(name, args, 1)
    return parseJson(stringifyValue(evaluateNode(requiredArg(args, 0, name), context, source)))
  }
  if (name === "len") {
    ensureArity(name, args, 1)
    const value = evaluateNode(requiredArg(args, 0, name), context, source)
    if (typeof value === "string" || Array.isArray(value)) {
      return value.length
    }
    if (isJsonObject(value)) {
      return Object.keys(value).length
    }
    throw new Error("len expects a string, array, or object")
  }

  throw new Error(`expression \`${source}\` calls unsupported function \`${name}\``)
}

function ensureArity(name: string, args: ExprNode[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`${name} expects ${expected} argument(s), got ${args.length}`)
  }
}

function requiredArg(args: ExprNode[], index: number, name: string): ExprNode {
  const arg = args[index]
  if (arg === undefined) {
    throw new Error(`${name} expects argument ${index + 1}`)
  }
  return arg
}

function resolvePath(context: JsonValue, root: ExprRoot, segments: string[]): unknown {
  let current: unknown = isJsonObject(context) ? (context[root] ?? null) : null
  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = current[Number.parseInt(segment, 10)] ?? null
      continue
    }
    if (isJsonObject(current)) {
      current = current[segment] ?? null
      continue
    }
    return null
  }
  return current
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false
  }
  if (typeof value === "boolean") {
    return value
  }
  if (typeof value === "number") {
    return value !== 0
  }
  if (typeof value === "string") {
    return value.length > 0
  }
  if (Array.isArray(value)) {
    return value.length > 0
  }
  if (isJsonObject(value)) {
    return Object.keys(value).length > 0
  }
  return true
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  const jsonValue = asJsonValue(value)
  return jsonValue === undefined ? String(value) : stableStringify(jsonValue)
}

function stableStringify(value: unknown): string {
  const jsonValue = asJsonValue(value)
  return JSON.stringify(sortJsonValue(jsonValue ?? null))
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue)
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCanonicalStrings(left, right))
        .map(([key, item]) => [key, sortJsonValue(item)] as const),
    )
  }
  return value
}

function inferNodeShape(node: ExprNode, resolvePath: (reference: PathReference) => ResultShape): ResultShape {
  switch (node.kind) {
    case "literal":
      return shapeFromJson(node.value)
    case "path":
      return resolvePath({ root: node.root, segments: [...node.segments] })
    case "not":
      return BooleanShape
    case "binary":
      return BooleanShape
    case "call":
      return inferCallShape(node, resolvePath)
  }
}

function inferCallShape(
  node: Extract<ExprNode, { kind: "call" }>,
  resolvePath: (reference: PathReference) => ResultShape,
): ResultShape {
  if (node.name === "contains" || node.name === "startsWith" || node.name === "endsWith") {
    return BooleanShape
  }
  if (node.name === "len") {
    return IntegerShape
  }
  if (node.name === "format" || node.name === "join" || node.name === "toJSON") {
    return StringShape
  }
  if (node.name === "fromJSON") {
    const [first] = node.args
    if (first?.kind === "literal" && typeof first.value === "string") {
      try {
        const parsed = parseJson(first.value)
        const jsonValue = asJsonValue(parsed)
        return jsonValue === undefined ? AnyJsonShape : shapeFromJson(jsonValue)
      } catch {
        return AnyJsonShape
      }
    }
    if (first?.kind === "call" && first.name === "toJSON" && first.args.length === 1) {
      return inferNodeShape(requiredArg(first.args, 0, first.name), resolvePath)
    }
    return AnyJsonShape
  }
  return AnyJsonShape
}
