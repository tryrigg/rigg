import { renderString } from "../../workflow/expr"
import type { ActionNode } from "../../workflow/schema"
import type { RenderContext } from "../render"
import { stepFailed } from "../error"
import { runCodexStep, type CodexStepOptions } from "./codex"
import { runShellStep, type ActionStepOutput } from "./shell"
import { runWriteFileStep } from "./write-file"

export type { ActionExecutionOptions, ActionStepOutput, ProcessOutput, StreamEventParser } from "./shell"

export async function runActionStep(
  step: ActionNode,
  context: RenderContext,
  options: CodexStepOptions,
): Promise<ActionStepOutput> {
  switch (step.type) {
    case "shell":
      return await runShellStep(applyTemplate(step.with.command, context), {
        cwd: options.cwd,
        env: options.env,
        onOutput: options.onOutput,
        resultMode: step.with.result ?? "text",
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
  }
}

function applyTemplate(template: string, context: RenderContext): string {
  try {
    return renderString(template, context)
  } catch (error) {
    throw stepFailed(error)
  }
}
