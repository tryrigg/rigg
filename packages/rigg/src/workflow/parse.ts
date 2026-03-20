import { parse } from "yaml"

import { createDiag, CompileDiagnosticCode, type CompileDiagnostic } from "./diag"
import { normalizeError } from "../util/error"

export type YamlParseResult = { kind: "parsed"; document: unknown } | { kind: "invalid_yaml"; error: CompileDiagnostic }

export function parseYaml(text: string, filePath: string): YamlParseResult {
  try {
    return { kind: "parsed", document: parse(text) }
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
