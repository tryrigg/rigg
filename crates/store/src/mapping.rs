use crate::protocol::{
    Event, EventRecord, LoopEvaluated, Meta, RunFinished, RunReason, RunSnapshot, RunStatus,
    StepRecord, StepSnapshot, StepStatus,
};
use rigg_core::{
    CapturedValue, RunEvent, RunEventRecord, RunMeta, RunState, StepEvent, StepResult,
};

pub fn meta_from_core(meta: &RunMeta) -> Meta {
    Meta {
        run_id: meta.run_id.to_string(),
        flow_name: meta.flow_name.to_string(),
        cwd: meta.cwd.display().to_string(),
        started_at: meta.started_at.clone(),
        tool_version: meta.tool_version.clone(),
        config_hash: meta.config_hash.clone(),
        config_files: meta.config_files.iter().map(|path| path.display().to_string()).collect(),
        invocation_inputs: meta.invocation_inputs.clone(),
    }
}

pub fn event_record_from_core(record: &RunEventRecord) -> EventRecord {
    EventRecord { ts: record.ts.clone(), event: event_from_core(&record.event) }
}

pub fn snapshot_from_core(state: &RunState) -> RunSnapshot {
    RunSnapshot {
        run_id: state.run_id.to_string(),
        flow_name: state.flow_name.to_string(),
        status: run_status_from_core(state.status),
        reason: state.reason.map(run_reason_from_core),
        current_iteration: state.current_iteration,
        max_iterations: state.max_iterations,
        started_at: state.started_at.clone(),
        finished_at: state.finished_at.clone(),
        steps: state.steps.iter().map(step_snapshot_from_core).collect(),
    }
}

fn event_from_core(event: &RunEvent) -> Event {
    match event {
        RunEvent::RunStarted { run_id, flow_name, cwd, max_iterations } => Event::RunStarted {
            run_id: run_id.to_string(),
            flow_name: flow_name.to_string(),
            cwd: cwd.display().to_string(),
            max_iterations: *max_iterations,
        },
        RunEvent::IterationStarted { iteration } => {
            Event::IterationStarted { iteration: *iteration }
        }
        RunEvent::StepStarted { iteration, step_id, attempt, command } => Event::StepStarted {
            iteration: *iteration,
            step_id: step_id.to_string(),
            attempt: *attempt,
            command: command.clone(),
        },
        RunEvent::StepSkipped { iteration, step_id, reason } => Event::StepSkipped {
            iteration: *iteration,
            step_id: step_id.to_string(),
            reason: reason.clone(),
        },
        RunEvent::StepFinished(step) => Event::StepFinished(Box::new(step_record_from_core(step))),
        RunEvent::LoopEvaluated { iteration, result } => {
            Event::LoopEvaluated(LoopEvaluated { iteration: *iteration, result: *result })
        }
        RunEvent::RunFinished { status, reason } => Event::RunFinished(RunFinished {
            status: run_status_from_core(*status),
            reason: run_reason_from_core(*reason),
        }),
        RunEvent::RunFailed { reason, message } => {
            Event::RunFailed { reason: run_reason_from_core(*reason), message: message.clone() }
        }
    }
}

fn step_snapshot_from_core(step: &StepResult) -> StepSnapshot {
    StepSnapshot {
        step_id: step.step_id.to_string(),
        index: step.index,
        attempt: step.attempt,
        status: step_status_from_core(step.status),
        started_at: step.started_at.clone(),
        finished_at: step.finished_at.clone(),
        duration_ms: step.duration_ms,
        exit_code: step.exit_code,
        stdout_path: step.stdout_path.clone(),
        stderr_path: step.stderr_path.clone(),
        stdout_preview: step.stdout_preview.clone(),
        stderr_preview: step.stderr_preview.clone(),
        stdout: step.stdout.as_ref().map(captured_value_to_json),
        stderr: step.stderr.clone(),
        result: step.result.as_ref().map(captured_value_to_json),
        outputs: serde_json::Value::Object(step.outputs.clone()),
    }
}

fn step_record_from_core(step: &StepEvent) -> StepRecord {
    StepRecord {
        iteration: step.iteration,
        step_id: step.step_id.to_string(),
        attempt: step.attempt,
        exit_code: step.exit_code,
        status: step_status_from_core(step.status),
        stdout_path: step.stdout_path.clone(),
        stderr_path: step.stderr_path.clone(),
        stdout_preview: step.stdout_preview.clone(),
        stderr_preview: step.stderr_preview.clone(),
        stdout: step.stdout.as_ref().map(captured_value_to_json),
        stderr: step.stderr.clone(),
        result: step.result.as_ref().map(captured_value_to_json),
        outputs: serde_json::Value::Object(step.outputs.clone()),
    }
}

fn captured_value_to_json(value: &CapturedValue) -> serde_json::Value {
    match value {
        CapturedValue::Text(text) => serde_json::Value::String(text.clone()),
        CapturedValue::Json(json) => json.clone(),
    }
}

fn run_status_from_core(status: rigg_core::RunStatus) -> RunStatus {
    match status {
        rigg_core::RunStatus::Running => RunStatus::Running,
        rigg_core::RunStatus::Succeeded => RunStatus::Succeeded,
        rigg_core::RunStatus::Failed => RunStatus::Failed,
    }
}

fn run_reason_from_core(reason: rigg_core::RunReason) -> RunReason {
    match reason {
        rigg_core::RunReason::Completed => RunReason::Completed,
        rigg_core::RunReason::LoopMaxExhausted => RunReason::LoopMaxExhausted,
        rigg_core::RunReason::StepFailed => RunReason::StepFailed,
        rigg_core::RunReason::EvaluationError => RunReason::EvaluationError,
        rigg_core::RunReason::EngineError => RunReason::EngineError,
        rigg_core::RunReason::ValidationError => RunReason::ValidationError,
    }
}

fn step_status_from_core(status: rigg_core::StepStatus) -> StepStatus {
    match status {
        rigg_core::StepStatus::Pending => StepStatus::Pending,
        rigg_core::StepStatus::Skipped => StepStatus::Skipped,
        rigg_core::StepStatus::Succeeded => StepStatus::Succeeded,
        rigg_core::StepStatus::Failed => StepStatus::Failed,
    }
}
