use crate::conversation::ConversationProvider;
use crate::ids::{FrameId, NodePath, RunId, StepId, WorkflowId};
use crate::run::event::{
    BranchSelection, LoopIterationOutcome, NodeStatus, RunReason, RunStatus, StreamKind,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderEvent {
    ToolUse { provider: ConversationProvider, tool: String, detail: Option<String> },
    Status { provider: ConversationProvider, message: String },
    Error { provider: ConversationProvider, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveEvent {
    RunStarted {
        run_id: RunId,
        workflow_id: WorkflowId,
        node_count: usize,
    },
    NodeStarted {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        node_kind: String,
        provider: Option<ConversationProvider>,
        attempt: u32,
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
    StepOutput {
        stream: StreamKind,
        chunk: String,
    },
    ProviderToolUse {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        provider: ConversationProvider,
        tool: String,
        detail: Option<String>,
    },
    ProviderStatus {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        provider: ConversationProvider,
        message: String,
    },
    ProviderError {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        provider: ConversationProvider,
        message: String,
    },
    NodeFinished {
        frame_id: FrameId,
        node_path: NodePath,
        user_id: Option<StepId>,
        status: NodeStatus,
        exit_code: Option<i32>,
        duration_ms: Option<u128>,
        stdout_path: Option<String>,
        stderr_path: Option<String>,
    },
    RunFinished {
        status: RunStatus,
        reason: RunReason,
    },
}

pub trait ProgressSink {
    fn is_enabled(&self) -> bool {
        false
    }

    fn emit(&mut self, _event: LiveEvent) {}
}

pub trait StepProgressSink {
    fn is_enabled(&self) -> bool {
        false
    }

    fn step_output(&mut self, _stream: StreamKind, _chunk: &str) {}

    fn provider_event(&mut self, _event: ProviderEvent) {}
}

#[derive(Debug, Default)]
pub struct NoopProgressSink;

impl ProgressSink for NoopProgressSink {}
impl StepProgressSink for NoopProgressSink {}
