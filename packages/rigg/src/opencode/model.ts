export type ParseModelResult =
  | { kind: "invalid"; message: string }
  | { kind: "none" }
  | { kind: "ok"; modelID: string; providerID: string }

export function parseModel(model: string | undefined): ParseModelResult {
  if (model === undefined) {
    return { kind: "none" }
  }

  const trimmed = model.trim()
  if (trimmed.length === 0) {
    return { kind: "invalid", message: `Invalid OpenCode model "${model}". Use "provider/model".` }
  }

  const slash = trimmed.indexOf("/")
  if (slash < 0) {
    return { kind: "invalid", message: `Invalid OpenCode model "${model}". Use "provider/model".` }
  }

  const providerID = trimmed.slice(0, slash)
  const modelID = trimmed.slice(slash + 1)
  if (providerID.length === 0 || modelID.length === 0) {
    return { kind: "invalid", message: `Invalid OpenCode model "${model}". Use "provider/model".` }
  }

  return { kind: "ok", modelID, providerID }
}
