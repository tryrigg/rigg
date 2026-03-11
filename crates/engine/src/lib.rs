mod action;
mod context;
mod conversations;
mod error;
mod execute;
mod protocol;
mod record;
mod render;
mod result;
mod run_state;
mod runner;

#[cfg(test)]
mod tests;

pub use error::{
    EngineError, EvaluationError, ExecutorError, RecorderError, RenderError, ResultError,
    ValidationError,
};
pub use protocol::Engine;
pub use protocol::{
    Clock, ExecutionPlan, RenderedClaudeConversation, RenderedClaudeRequest, RenderedCodexAction,
    RenderedCodexConversation, RenderedCodexRequest, RenderedReviewScope, RenderedShellRequest,
    RenderedWriteFileRequest, RunRecorder, StepRunRequest, StepRunResult, StepRunner,
};

pub(crate) use protocol::ExecutionPlan as EnginePlan;

pub(crate) use rigg_core::conversation;
pub(crate) use rigg_core::expr;
pub(crate) use rigg_core::ids;
pub(crate) use rigg_core::progress;
pub(crate) use rigg_core::run::{event, state};
pub(crate) use rigg_core::workflow;
#[allow(unused_imports)]
pub(crate) use rigg_core::{
    ActionKind, ActionNode, BranchCase, BranchGuard, BranchNode, BranchSelection, CapturedValue,
    ClaudeStep, CodexAction, CodexExec, CodexMode, CodexStep, CompiledExpr, ConversationBinding,
    ConversationHandle, ConversationName, ConversationScope, Execution, ExpectedType, ExportField,
    ExportSpec, ExprError, FrameId, GroupNode, InputSchema, JsonResultSchema, LiveEvent,
    LoopIterationOutcome, LoopNode, LoopScopeId, NodeAttrs, NodeEvent, NodeId, NodeKind, NodePath,
    NodeResult, NodeStatus, OutputType, ParallelBranch, ParallelNode, PermissionMode, Persistence,
    ResultContract, ResultShape, ResultSpec, RunEvent, RunEventRecord, RunId, RunMeta, RunReason,
    RunState, RunStatus, ShellOutput, ShellStep, StepId, StreamKind, Template, TemplateField,
    ValidatedBlock, ValidatedNode, ValidatedWorkflow, WorkflowId,
};
