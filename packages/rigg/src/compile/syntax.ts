import { parse } from "yaml"

import { createCompileError, CompileErrorCode, type CompileError } from "./diagnostics"
import { normalizeError } from "../util/error"

export type YamlParseResult = { kind: "parsed"; document: unknown } | { kind: "invalid_yaml"; error: CompileError }

export function parseYamlDocument(text: string, filePath: string): YamlParseResult {
  try {
    return { kind: "parsed", document: parse(text) as unknown }
  } catch (error) {
    return {
      kind: "invalid_yaml",
      error: createCompileError(CompileErrorCode.InvalidYaml, "Failed to parse workflow YAML.", {
        filePath,
        cause: normalizeError(error),
      }),
    }
  }
}
