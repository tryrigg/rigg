use crate::event::{RunReason, RunStatus, StepStatus};
use crate::ids::{FlowName, RunId, StepId};
use serde_json::{Map as JsonMap, Value as JsonValue};

#[derive(Debug, Clone, PartialEq)]
pub enum CapturedValue {
    Text(String),
    Json(JsonValue),
}

impl CapturedValue {
    pub fn as_json(&self) -> JsonValue {
        match self {
            Self::Text(text) => JsonValue::String(text.clone()),
            Self::Json(value) => value.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StepResult {
    pub step_id: StepId,
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
    pub stdout: Option<CapturedValue>,
    pub stderr: Option<String>,
    pub result: Option<CapturedValue>,
    pub outputs: JsonMap<String, JsonValue>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunState {
    pub run_id: RunId,
    pub flow_name: FlowName,
    pub status: RunStatus,
    pub reason: Option<RunReason>,
    pub current_iteration: u32,
    pub max_iterations: u32,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub steps: Vec<StepResult>,
}
