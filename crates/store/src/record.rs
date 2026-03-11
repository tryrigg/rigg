use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    StepFailed,
    StepTimedOut,
    EvaluationError,
    EngineError,
    ValidationError,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Skipped,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LoopIterationOutcome {
    Continue,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BranchSelection {
    If,
    Else,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Meta {
    pub run_id: String,
    pub workflow_id: String,
    pub cwd: String,
    pub started_at: String,
    pub tool_version: String,
    pub config_hash: String,
    pub config_files: Vec<String>,
    pub invocation_inputs: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NodeSnapshot {
    pub node_path: String,
    pub user_id: Option<String>,
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
    pub stdout: Option<serde_json::Value>,
    pub stderr: Option<String>,
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum ConversationSnapshot {
    Claude {
        #[serde(rename = "id")]
        session_id: String,
    },
    Codex {
        #[serde(rename = "id")]
        thread_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSnapshot {
    pub run_id: String,
    pub workflow_id: String,
    pub status: RunStatus,
    pub reason: Option<RunReason>,
    pub started_at: String,
    pub finished_at: Option<String>,
    #[serde(default)]
    pub conversations: BTreeMap<String, ConversationSnapshot>,
    pub nodes: Vec<NodeSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct NodeRecord {
    pub frame_id: String,
    pub node_path: String,
    pub user_id: Option<String>,
    pub attempt: u32,
    pub exit_code: Option<i32>,
    pub status: NodeStatus,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout: Option<serde_json::Value>,
    pub stderr: Option<String>,
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct RunFinished {
    pub status: RunStatus,
    pub reason: RunReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Event {
    RunStarted {
        run_id: String,
        workflow_id: String,
        cwd: String,
        node_count: usize,
    },
    NodeStarted {
        frame_id: String,
        node_path: String,
        user_id: Option<String>,
        node_kind: String,
        attempt: u32,
        command: String,
    },
    NodeSkipped {
        frame_id: String,
        node_path: String,
        user_id: Option<String>,
        reason: String,
    },
    BranchSelected {
        frame_id: String,
        node_path: String,
        user_id: Option<String>,
        case_index: usize,
        selection: BranchSelection,
    },
    LoopIterationStarted {
        frame_id: String,
        node_path: String,
        user_id: Option<String>,
        iteration: u32,
        max_iterations: u32,
    },
    LoopIterationFinished {
        frame_id: String,
        node_path: String,
        user_id: Option<String>,
        iteration: u32,
        max_iterations: u32,
        outcome: LoopIterationOutcome,
    },
    NodeFinished(Box<NodeRecord>),
    RunFinished(RunFinished),
    RunFailed {
        reason: RunReason,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct EventRecord {
    pub ts: String,
    #[serde(flatten)]
    pub event: Event,
}

#[cfg(test)]
mod tests {
    use super::ConversationSnapshot;

    #[test]
    fn serializes_conversation_snapshot_with_stable_id_field()
    -> Result<(), Box<dyn std::error::Error>> {
        let json = serde_json::to_value(ConversationSnapshot::Claude {
            session_id: "session-123".to_owned(),
        })?;

        assert_eq!(
            json,
            serde_json::json!({
                "provider": "claude",
                "id": "session-123",
            })
        );
        Ok(())
    }
}
