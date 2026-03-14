import type { RunProgressEvent } from "../run/progress"

export class TerminalProgressSink {
  readonly #stream: NodeJS.WriteStream

  constructor(stream: NodeJS.WriteStream) {
    this.#stream = stream
  }

  emit(event: RunProgressEvent): void {
    switch (event.kind) {
      case "run_started":
        this.#stream.write(`[run] id=${event.run_id} workflow=${event.workflow_id} nodes=${event.node_count}\n`)
        return
      case "node_started":
        this.#stream.write(
          `[start] node=${event.user_id ?? event.node_path} kind=${event.node_kind} provider=${event.provider ?? "-"} attempt=${event.attempt}\n`,
        )
        return
      case "node_skipped":
        this.#stream.write(`[skip] node=${event.user_id ?? event.node_path} reason=${event.reason}\n`)
        return
      case "branch_selected":
        this.#stream.write(
          `[branch] node=${event.user_id ?? event.node_path} case=${event.case_index} kind=${event.selection}\n`,
        )
        return
      case "loop_iteration_started":
        this.#stream.write(
          `[loop] node=${event.user_id ?? event.node_path} iteration=${event.iteration}/${event.max_iterations} status=started\n`,
        )
        return
      case "loop_iteration_finished":
        this.#stream.write(
          `[loop] node=${event.user_id ?? event.node_path} iteration=${event.iteration}/${event.max_iterations} status=${event.outcome}\n`,
        )
        return
      case "step_output":
        this.#stream.write(event.chunk)
        return
      case "provider_tool_use":
        this.#stream.write(
          `[tool] node=${event.user_id ?? event.node_path} provider=${event.provider} tool=${event.tool}${event.detail === null ? "" : ` ${event.detail}`}\n`,
        )
        return
      case "provider_status":
        this.#stream.write(
          `[progress] node=${event.user_id ?? event.node_path} provider=${event.provider} ${event.message}\n`,
        )
        return
      case "provider_error":
        this.#stream.write(
          `[error] node=${event.user_id ?? event.node_path} provider=${event.provider} ${event.message}\n`,
        )
        return
      case "node_finished":
        this.#stream.write(
          `[done] node=${event.user_id ?? event.node_path} status=${event.status} exit=${String(event.exit_code)} duration=${formatDuration(event.duration_ms)} stdout=${event.stdout_path ?? "-"} stderr=${event.stderr_path ?? "-"}\n`,
        )
        return
      case "run_finished":
        this.#stream.write(`[run] status=${event.status} reason=${event.reason}\n`)
    }
  }
}

function formatDuration(durationMs: number | null): string {
  return durationMs === null ? "-" : `${durationMs}ms`
}
