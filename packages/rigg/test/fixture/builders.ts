import type { WorkflowProject } from "../../src/compile/project"
import type { WorkflowDocument } from "../../src/compile/schema"
import type { RenderContext, StepBinding } from "../../src/run/render"
import type { RunSnapshot } from "../../src/history/schema"

export function workflowProject(
  files: Array<{
    filePath?: string
    relativePath?: string
    workflow: WorkflowDocument
  }>,
): WorkflowProject {
  return {
    files: files.map((file, index) => ({
      filePath: file.filePath ?? `/workspace/.rigg/workflow-${index + 1}.yaml`,
      relativePath: file.relativePath ?? `workflow-${index + 1}.yaml`,
      workflow: file.workflow,
    })),
    workspace: {
      riggDir: "/workspace/.rigg",
      rootDir: "/workspace",
    },
  }
}

export function runSnapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    conversations: overrides.conversations ?? {},
    finished_at: overrides.finished_at ?? null,
    nodes: overrides.nodes ?? [],
    reason: overrides.reason ?? null,
    run_id: overrides.run_id ?? "run-123",
    started_at: overrides.started_at ?? "2026-03-14T00:00:00.000Z",
    status: overrides.status ?? "running",
    workflow_id: overrides.workflow_id ?? "workflow",
  }
}

export function renderContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    env: overrides.env ?? { CI: "true" },
    inputs: overrides.inputs ?? { name: "Rigg" },
    run: overrides.run ?? { iteration: 1 },
    steps: overrides.steps ?? {
      draft: {
        result: { accepted: true },
        status: "succeeded",
      },
    },
  }
}

export function stepBinding(overrides: Partial<StepBinding> = {}): StepBinding {
  return {
    result: overrides.result ?? "done",
    status: overrides.status ?? "succeeded",
  }
}
