use super::event::{NodeStatus, RunReason, RunStatus};
use crate::conversation::ConversationHandle;
use crate::ids::{ConversationName, FrameId, NodePath, RunId, StepId, WorkflowId};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

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
pub struct Execution {
    pub user_id: Option<StepId>,
    pub attempt: u32,
    pub status: NodeStatus,
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeResult {
    pub node_path: NodePath,
    pub execution: Execution,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeFrameResult {
    pub frame_id: FrameId,
    pub node_path: NodePath,
    pub execution: Execution,
}

impl Execution {
    pub fn pending(user_id: Option<StepId>) -> Self {
        Self {
            user_id,
            attempt: 0,
            status: NodeStatus::Pending,
            started_at: None,
            finished_at: None,
            duration_ms: None,
            exit_code: None,
            stdout_path: None,
            stderr_path: None,
            stdout_preview: String::new(),
            stderr_preview: String::new(),
            stdout: None,
            stderr: None,
            result: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunState {
    pub run_id: RunId,
    pub workflow_id: WorkflowId,
    pub status: RunStatus,
    pub reason: Option<RunReason>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub workflow_conversations: BTreeMap<ConversationName, ConversationHandle>,
    pub nodes: BTreeMap<NodePath, NodeResult>,
    pub node_frames: BTreeMap<(FrameId, NodePath), NodeFrameResult>,
}
