import type { WorkflowProject } from "../../src/project"
import type { WorkflowDocument } from "../../src/workflow/schema"
import type { RenderContext, StepBinding } from "../../src/session/render"
import type { RunSnapshot } from "../../src/session/schema"

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
      source: {
        locs: new Map(),
        text: "",
      },
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
    active_barrier: overrides.active_barrier ?? null,
    active_interaction: overrides.active_interaction ?? null,
    finished_at: overrides.finished_at ?? null,
    nodes: overrides.nodes ?? [],
    phase: overrides.phase ?? "running",
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
