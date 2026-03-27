import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument } from "yaml"

import { createDiag, CompileDiagnosticCode, type CompileDiagnostic } from "./diag"
import { normalizeError } from "../util/error"

export type YamlPath = Array<string | number>

export type YamlLoc = {
  column: number
  line: number
  snippet: string
}

export type YamlSource = {
  locs: Map<string, YamlLoc>
}

export type YamlParseResult =
  | { kind: "parsed"; document: unknown; source: YamlSource }
  | { kind: "invalid_yaml"; error: CompileDiagnostic }

export function parseYaml(text: string, filePath: string): YamlParseResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const lineCounter = new LineCounter()

  try {
    const doc = parseDocument(text, {
      lineCounter,
      prettyErrors: false,
    })
    const yamlError = doc.errors[0]
    if (yamlError !== undefined) {
      const loc = rangeLoc(lines, lineCounter, yamlError.pos)
      return {
        kind: "invalid_yaml",
        error: createDiag(CompileDiagnosticCode.InvalidYaml, "Failed to parse workflow YAML.", {
          cause: normalizeError(yamlError),
          filePath,
          ...loc,
        }),
      }
    }

    return {
      document: doc.toJS(),
      kind: "parsed",
      source: buildSource(lines, lineCounter, doc.contents),
    }
  } catch (error) {
    return {
      kind: "invalid_yaml",
      error: createDiag(CompileDiagnosticCode.InvalidYaml, "Failed to parse workflow YAML.", {
        filePath,
        cause: normalizeError(error),
      }),
    }
  }
}

export function findYamlLoc(source: YamlSource | undefined, path: YamlPath): YamlLoc | undefined {
  if (source === undefined) {
    return undefined
  }

  const found = source.locs.get(pathKey(path))
  if (found !== undefined) {
    return found
  }

  for (let i = path.length - 1; i >= 0; i -= 1) {
    const parent = source.locs.get(pathKey(path.slice(0, i)))
    if (parent !== undefined) {
      return parent
    }
  }

  return source.locs.get("")
}

function buildSource(lines: string[], lineCounter: LineCounter, root: unknown): YamlSource {
  const source = {
    locs: new Map<string, YamlLoc>(),
  }
  indexNode(source, lines, lineCounter, root, [])
  return source
}

function indexNode(source: YamlSource, lines: string[], lineCounter: LineCounter, node: unknown, path: YamlPath): void {
  record(source, lines, lineCounter, path, rangeFor(node))

  if (isMap(node)) {
    for (const item of node.items) {
      if (!isPair(item)) {
        continue
      }
      indexPair(source, lines, lineCounter, item, path)
    }
    return
  }

  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      if (item === null) {
        return
      }
      indexNode(source, lines, lineCounter, item, [...path, index])
    })
  }
}

function indexPair(
  source: YamlSource,
  lines: string[],
  lineCounter: LineCounter,
  node: { key: unknown; value: unknown },
  path: YamlPath,
): void {
  const key = pairKey(node.key)
  if (key === undefined) {
    return
  }

  const next = [...path, key]
  record(source, lines, lineCounter, next, rangeFor(node.key) ?? rangeFor(node.value))
  if (node.value !== null) {
    indexNode(source, lines, lineCounter, node.value, next)
  }
}

function pairKey(node: unknown): string | number | undefined {
  if (!isScalar(node)) {
    return undefined
  }

  const value = node.toJSON()
  if (typeof value === "string" || typeof value === "number") {
    return value
  }

  return undefined
}

function rangeFor(node: unknown): [number, number, number] | undefined {
  if (typeof node !== "object" || node === null || !("range" in node)) {
    return undefined
  }
  return Array.isArray(node.range) ? (node.range as [number, number, number]) : undefined
}

function record(
  source: YamlSource,
  lines: string[],
  lineCounter: LineCounter,
  path: YamlPath,
  range: [number, number, number] | undefined,
): void {
  const key = pathKey(path)
  if (source.locs.has(key)) {
    return
  }

  const loc = rangeLoc(lines, lineCounter, range)
  if (loc === undefined) {
    return
  }

  source.locs.set(key, loc)
}

function rangeLoc(
  lines: string[],
  lineCounter: LineCounter,
  range: [number, number, number] | readonly [number, number] | undefined,
): YamlLoc | undefined {
  if (range === undefined) {
    return undefined
  }

  const pos = lineCounter.linePos(range[0])
  const line = pos.line + 1
  const column = pos.col + 1
  return {
    column,
    line,
    snippet: lines[pos.line] ?? "",
  }
}

function pathKey(path: YamlPath): string {
  return path.map(String).join(".")
}
