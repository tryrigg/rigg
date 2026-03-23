import type { ActionNode } from "../../workflow/schema"
import type { RenderContext } from "../render"
import { runClaudeStep } from "./claude"
import { runCodexStep } from "./codex"
import { runCursorStep } from "./cursor"
import { runShellStep, type ActionStepOutput, type ProviderStepOptions } from "./shell"
import { applyTemplate } from "./template"
import { runWriteFileStep } from "./write-file"

export type {
  ActionExecutionOptions,
  ActionStepOutput,
  ProcessOutput,
  ProviderStepOptions,
  StreamEventParser,
} from "./shell"

export async function runActionStep(
  step: ActionNode,
  context: RenderContext,
  options: ProviderStepOptions,
): Promise<ActionStepOutput> {
  switch (step.type) {
    case "shell":
      return await runShellStep(applyTemplate(step.with.command, context), {
        cwd: options.cwd,
        env: options.env,
        onOutput: options.onOutput,
        stdoutMode: step.with.stdout?.mode ?? "text",
        signal: options.signal,
      })
    case "write_file": {
      const path = applyTemplate(step.with.path, context)
      const content = applyTemplate(step.with.content, context)
      return {
        exitCode: 0,
        providerEvents: [],
        result: await runWriteFileStep(path, content, options.cwd),
        stderr: "",
        stdout: "",
        termination: "completed",
      }
    }
    case "codex":
      return await runCodexStep(step, context, options)
    case "claude":
      return await runClaudeStep(step, context, options)
    case "cursor":
      return await runCursorStep(step, context, options)
  }
}
