mod branch;
mod group;
mod r#loop;
mod parallel;

use super::context;
use super::error::eval_error;
use super::protocol::{RunRecorder, format_log_path};
use super::{
    BranchSelection, Engine, EngineError, ExecutorError, LiveEvent, LoopIterationOutcome,
    NodeStatus, RecorderError, RunEvent, RunEventRecord, RunState, RunStatus,
};
use crate::StreamKind;
use crate::ids::{NodePath, StepId};
use crate::progress::ProgressSink;
use crate::state::CapturedValue;
use crate::workflow::{BranchCase, BranchGuard, ValidatedBlock};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, mpsc};

fn branch_selection(case: &BranchCase) -> BranchSelection {
    match &case.guard {
        BranchGuard::If(_) => BranchSelection::If,
        BranchGuard::Else => BranchSelection::Else,
    }
}

#[derive(Debug)]
struct ParallelBranchCompletion {
    branch_index: usize,
    branch_result: Result<(), EngineError>,
    branch_state: RunState,
    branch_visible: BTreeMap<StepId, NodePath>,
    branch_conversations: super::conversations::ConversationState,
}

struct ParallelBranchTask<'a> {
    branch_index: usize,
    branch: &'a crate::ParallelBranch,
    node_path: &'a crate::NodePath,
    parent_frame: &'a context::FrameContext,
    plan: &'a crate::EnginePlan,
    step_runner: &'a dyn crate::StepRunner,
    clock: &'a dyn crate::Clock,
    branch_state: RunState,
    branch_visible: BTreeMap<StepId, NodePath>,
    run_artifacts_dir: std::path::PathBuf,
    conversations: super::conversations::ConversationState,
    progress_enabled: bool,
    emitter: ParallelBranchEmitter,
}

#[derive(Debug)]
enum ParallelBranchMessage {
    Event(RunEventRecord),
    Log(BufferedLog),
    Progress(LiveEvent),
    StateCheckpoint { branch_index: usize, branch_state: RunState },
    Completed(ParallelBranchCompletion),
}

#[derive(Debug, Clone)]
struct ParallelBranchEmitter {
    sender: mpsc::Sender<ParallelBranchMessage>,
}

impl ParallelBranchEmitter {
    fn new(sender: mpsc::Sender<ParallelBranchMessage>) -> Self {
        Self { sender }
    }

    fn send(&self, message: ParallelBranchMessage) -> Result<(), EngineError> {
        self.sender.send(message).map_err(|_| {
            EngineError::Executor(ExecutorError::RunTool {
                program: "parallel-branch".to_owned(),
                source: std::io::Error::other("parallel branch receiver closed"),
            })
        })
    }
}

#[derive(Debug)]
struct ParallelBranchProgress {
    enabled: bool,
    emitter: ParallelBranchEmitter,
}

impl ParallelBranchProgress {
    fn new(enabled: bool, emitter: ParallelBranchEmitter) -> Self {
        Self { enabled, emitter }
    }
}

impl ProgressSink for ParallelBranchProgress {
    fn is_enabled(&self) -> bool {
        self.enabled
    }

    fn emit(&mut self, event: LiveEvent) {
        if self.enabled {
            let _ = self.emitter.send(ParallelBranchMessage::Progress(event));
        }
    }
}

struct ParallelBranchRecorder {
    branch_index: usize,
    run_artifacts_dir: std::path::PathBuf,
    emitter: ParallelBranchEmitter,
    log_keys: Mutex<BTreeMap<String, BufferedLogKey>>,
}

impl ParallelBranchRecorder {
    fn new(
        branch_index: usize,
        run_artifacts_dir: std::path::PathBuf,
        emitter: ParallelBranchEmitter,
    ) -> Self {
        Self { branch_index, run_artifacts_dir, emitter, log_keys: Mutex::new(BTreeMap::new()) }
    }
}

#[derive(Debug, Clone)]
struct BufferedLogKey {
    frame_id: crate::FrameId,
    node_path: NodePath,
    attempt: u32,
    stream: StreamKind,
}

#[derive(Debug, Clone)]
struct BufferedLog {
    buffered_path: String,
    frame_id: crate::FrameId,
    node_path: NodePath,
    attempt: u32,
    stream: StreamKind,
    chunk: String,
}

impl RunRecorder for ParallelBranchRecorder {
    fn init_run(&mut self, _state: &RunState, _meta: &crate::RunMeta) -> Result<(), EngineError> {
        Ok(())
    }

    fn append_event(&mut self, event: &RunEventRecord) -> Result<(), EngineError> {
        self.emitter.send(ParallelBranchMessage::Event(event.clone()))
    }

    fn write_state(&mut self, state: &RunState) -> Result<(), EngineError> {
        self.emitter.send(ParallelBranchMessage::StateCheckpoint {
            branch_index: self.branch_index,
            branch_state: state.clone(),
        })
    }

    fn run_artifacts_dir(&self) -> Result<std::path::PathBuf, EngineError> {
        Ok(self.run_artifacts_dir.clone())
    }

    fn log_path(
        &self,
        frame_id: &crate::FrameId,
        node_path: &crate::NodePath,
        attempt: u32,
        stream: crate::StreamKind,
    ) -> String {
        let path = format_log_path(frame_id, node_path, attempt, stream);
        self.log_keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(path.clone())
            .or_insert_with(|| BufferedLogKey {
                frame_id: frame_id.clone(),
                node_path: node_path.clone(),
                attempt,
                stream,
            });
        path
    }

    fn append_log(&mut self, path: &str, chunk: &str) -> Result<(), EngineError> {
        let key = self
            .log_keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(path)
            .cloned()
            .ok_or_else(|| {
                EngineError::Recorder(RecorderError::BufferedLogPathNotRegistered {
                    path: path.to_owned(),
                })
            })?;
        self.emitter.send(ParallelBranchMessage::Log(BufferedLog {
            buffered_path: path.to_owned(),
            frame_id: key.frame_id,
            node_path: key.node_path,
            attempt: key.attempt,
            stream: key.stream,
            chunk: chunk.to_owned(),
        }))
    }
}

impl Engine {
    fn evaluate_export_spec(
        &self,
        export: &crate::ExportSpec,
        context: &JsonValue,
    ) -> Result<Option<CapturedValue>, EngineError> {
        let mut result = JsonMap::new();
        for field in &export.fields {
            let value = match field.expr.evaluate(context).map_err(eval_error)? {
                crate::expr::EvalOutcome::Bool(value) => JsonValue::Bool(value),
                crate::expr::EvalOutcome::Scalar(value) => JsonValue::String(value),
                crate::expr::EvalOutcome::Json(value) => value,
            };
            result.insert(field.key.clone(), value);
        }
        Ok(Some(CapturedValue::Json(JsonValue::Object(result))))
    }

    fn branch_case_matches(
        &self,
        case: &BranchCase,
        context: &JsonValue,
    ) -> Result<bool, EngineError> {
        match &case.guard {
            BranchGuard::If(condition) => match condition.evaluate(context).map_err(eval_error)? {
                crate::expr::EvalOutcome::Bool(value) => Ok(value),
                _ => unreachable!("boolean expressions always return bool"),
            },
            BranchGuard::Else => Ok(true),
        }
    }
}

fn merge_parallel_branch_state(
    state: &mut RunState,
    branch_state: &RunState,
    block: &ValidatedBlock,
) {
    let mut paths = BTreeSet::new();
    collect_block_paths(block, &mut paths);

    for path in &paths {
        if let Some(result) = branch_state.nodes.get(path) {
            state.nodes.insert(path.clone(), result.clone());
        }
    }
    state.node_frames.extend(
        branch_state
            .node_frames
            .iter()
            .filter(|((_, node_path), _)| paths.contains(node_path))
            .map(|(key, value)| (key.clone(), value.clone())),
    );
}

fn resolve_buffered_log_path(
    recorder: &dyn RunRecorder,
    resolved_log_paths: &mut BTreeMap<String, String>,
    log: &BufferedLog,
) -> String {
    resolved_log_paths
        .entry(log.buffered_path.clone())
        .or_insert_with(|| {
            recorder.log_path(&log.frame_id, &log.node_path, log.attempt, log.stream)
        })
        .clone()
}

fn rewrite_parallel_branch_state_log_paths(
    state: &mut RunState,
    block: &ValidatedBlock,
    resolved_log_paths: &BTreeMap<String, String>,
) {
    let mut paths = BTreeSet::new();
    collect_block_paths(block, &mut paths);

    for path in &paths {
        if let Some(result) = state.nodes.get_mut(path) {
            rewrite_execution_log_paths(&mut result.execution, resolved_log_paths);
        }
    }

    for ((_, node_path), result) in &mut state.node_frames {
        if paths.contains(node_path) {
            rewrite_execution_log_paths(&mut result.execution, resolved_log_paths);
        }
    }
}

fn rewrite_buffered_run_event_log_paths(
    event: &mut RunEventRecord,
    resolved_log_paths: &BTreeMap<String, String>,
) {
    if let RunEvent::NodeFinished(node_event) = &mut event.event {
        rewrite_optional_log_path(&mut node_event.stdout_path, resolved_log_paths);
        rewrite_optional_log_path(&mut node_event.stderr_path, resolved_log_paths);
    }
}

fn rewrite_buffered_progress_event_log_paths(
    event: &mut LiveEvent,
    resolved_log_paths: &BTreeMap<String, String>,
) {
    if let LiveEvent::NodeFinished { stdout_path, stderr_path, .. } = event {
        rewrite_optional_log_path(stdout_path, resolved_log_paths);
        rewrite_optional_log_path(stderr_path, resolved_log_paths);
    }
}

fn rewrite_execution_log_paths(
    execution: &mut crate::Execution,
    resolved_log_paths: &BTreeMap<String, String>,
) {
    rewrite_optional_log_path(&mut execution.stdout_path, resolved_log_paths);
    rewrite_optional_log_path(&mut execution.stderr_path, resolved_log_paths);
}

fn rewrite_optional_log_path(
    path: &mut Option<String>,
    resolved_log_paths: &BTreeMap<String, String>,
) {
    if let Some(current_path) = path.as_mut()
        && let Some(resolved) = resolved_log_paths.get(current_path)
    {
        *current_path = resolved.clone();
    }
}

fn collect_block_paths(block: &ValidatedBlock, paths: &mut BTreeSet<NodePath>) {
    for node in &block.nodes {
        paths.insert(node.path.clone());
        match &node.kind {
            crate::NodeKind::Action(_) => {}
            crate::NodeKind::Group(group_node) => collect_block_paths(&group_node.body, paths),
            crate::NodeKind::Loop(loop_node) => collect_block_paths(&loop_node.body, paths),
            crate::NodeKind::Branch(branch_node) => {
                for case in &branch_node.cases {
                    collect_block_paths(&case.body, paths);
                }
            }
            crate::NodeKind::Parallel(parallel_node) => {
                for branch in &parallel_node.branches {
                    collect_block_paths(&branch.body, paths);
                }
            }
        }
    }
}
