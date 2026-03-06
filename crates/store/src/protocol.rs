use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunReason {
    Completed,
    LoopMaxExhausted,
    StepFailed,
    EvaluationError,
    EngineError,
    ValidationError,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Skipped,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Meta {
    pub run_id: String,
    pub flow_name: String,
    pub cwd: String,
    pub started_at: String,
    pub tool_version: String,
    pub config_hash: String,
    pub config_files: Vec<String>,
    pub invocation_inputs: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StepSnapshot {
    pub step_id: String,
    pub index: usize,
    pub attempt: u32,
    pub status: StepStatus,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<u128>,
    pub exit_code: Option<i32>,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout: Option<serde_json::Value>,
    pub stderr: Option<String>,
    pub result: Option<serde_json::Value>,
    pub outputs: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSnapshot {
    pub run_id: String,
    pub flow_name: String,
    pub status: RunStatus,
    pub reason: Option<RunReason>,
    pub current_iteration: u32,
    pub max_iterations: u32,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub steps: Vec<StepSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StepRecord {
    pub iteration: u32,
    pub step_id: String,
    pub attempt: u32,
    pub exit_code: Option<i32>,
    pub status: StepStatus,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout: Option<serde_json::Value>,
    pub stderr: Option<String>,
    pub result: Option<serde_json::Value>,
    pub outputs: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoopEvaluated {
    pub iteration: u32,
    pub result: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunFinished {
    pub status: RunStatus,
    pub reason: RunReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    RunStarted { run_id: String, flow_name: String, cwd: String, max_iterations: u32 },
    IterationStarted { iteration: u32 },
    StepStarted { iteration: u32, step_id: String, attempt: u32, command: String },
    StepSkipped { iteration: u32, step_id: String, reason: String },
    StepFinished(Box<StepRecord>),
    LoopEvaluated(LoopEvaluated),
    RunFinished(RunFinished),
    RunFailed { reason: RunReason, message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventRecord {
    pub ts: String,
    #[serde(flatten)]
    pub event: Event,
}
