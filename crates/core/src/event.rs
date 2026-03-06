use crate::ids::{FlowName, RunId, StepId};
use crate::state::CapturedValue;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunReason {
    Completed,
    LoopMaxExhausted,
    StepFailed,
    EvaluationError,
    EngineError,
    ValidationError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepStatus {
    Pending,
    Skipped,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunMeta {
    pub run_id: RunId,
    pub flow_name: FlowName,
    pub cwd: PathBuf,
    pub started_at: String,
    pub tool_version: String,
    pub config_hash: String,
    pub config_files: Vec<PathBuf>,
    pub invocation_inputs: JsonValue,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepEvent {
    pub iteration: u32,
    pub step_id: StepId,
    pub attempt: u32,
    pub exit_code: Option<i32>,
    pub status: StepStatus,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout: Option<CapturedValue>,
    pub stderr: Option<String>,
    pub result: Option<CapturedValue>,
    pub outputs: JsonMap<String, JsonValue>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    RunStarted { run_id: RunId, flow_name: FlowName, cwd: PathBuf, max_iterations: u32 },
    IterationStarted { iteration: u32 },
    StepStarted { iteration: u32, step_id: StepId, attempt: u32, command: String },
    StepSkipped { iteration: u32, step_id: StepId, reason: String },
    StepFinished(Box<StepEvent>),
    LoopEvaluated { iteration: u32, result: bool },
    RunFinished { status: RunStatus, reason: RunReason },
    RunFailed { reason: RunReason, message: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunEventRecord {
    pub ts: String,
    pub event: RunEvent,
}
