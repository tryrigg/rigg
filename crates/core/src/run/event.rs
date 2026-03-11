use super::state::CapturedValue;
use crate::ids::{FrameId, NodePath, RunId, StepId, WorkflowId};
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
    StepFailed,
    StepTimedOut,
    EvaluationError,
    EngineError,
    ValidationError,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeStatus {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopIterationOutcome {
    Continue,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchSelection {
    If,
    Else,
}

impl BranchSelection {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::If => "if",
            Self::Else => "else",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunMeta {
    pub run_id: RunId,
    pub workflow_id: WorkflowId,
    pub cwd: PathBuf,
    pub started_at: String,
    pub tool_version: String,
    pub config_hash: String,
    pub config_files: Vec<PathBuf>,
    pub invocation_inputs: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeEvent {
    pub frame_id: FrameId,
    pub node_path: NodePath,
    pub user_id: Option<StepId>,
    pub attempt: u32,
    pub exit_code: Option<i32>,
    pub status: NodeStatus,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout: Option<CapturedValue>,
    pub stderr: Option<String>,
    pub result: Option<CapturedValue>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    RunStarted {
        run_id: RunId,
        workflow_id: WorkflowId,
        cwd: PathBuf,
        node_count: usize,
    },
    NodeStarted {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        node_kind: String,
        attempt: u32,
        command: String,
    },
    NodeSkipped {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        reason: String,
    },
    BranchSelected {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        case_index: usize,
        selection: BranchSelection,
    },
    LoopIterationStarted {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        iteration: u32,
        max_iterations: u32,
    },
    LoopIterationFinished {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        iteration: u32,
        max_iterations: u32,
        outcome: LoopIterationOutcome,
    },
    NodeFinished(Box<NodeEvent>),
    RunFinished {
        status: RunStatus,
        reason: RunReason,
    },
    RunFailed {
        reason: RunReason,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunEventRecord {
    pub ts: String,
    pub event: RunEvent,
}
