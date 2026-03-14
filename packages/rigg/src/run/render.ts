export type StepBinding = {
  result: unknown
  status: "failed" | "pending" | "skipped" | "succeeded"
}

export type RenderContext = {
  env: Record<string, string | undefined>
  inputs: Record<string, unknown>
  run: Record<string, unknown>
  steps: Record<string, StepBinding>
}
