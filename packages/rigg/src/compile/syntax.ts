import { parse } from "yaml"

import { createCompileDiagnostic, CompileDiagnosticCode, type CompileDiagnostic } from "./diagnostic"
import { normalizeError } from "../util/error"

export type YamlParseResult = { kind: "parsed"; document: unknown } | { kind: "invalid_yaml"; error: CompileDiagnostic }

export function parseYamlDocument(text: string, filePath: string): YamlParseResult {
  try {
    return { kind: "parsed", document: parse(text) }
  } catch (error) {
    return {
      kind: "invalid_yaml",
      error: createCompileDiagnostic(CompileDiagnosticCode.InvalidYaml, "Failed to parse workflow YAML.", {
        filePath,
        cause: normalizeError(error),
      }),
    }
  }
}
