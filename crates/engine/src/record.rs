use super::context;
use super::protocol::preview;
use super::runner::{ControlNodeCompletion, RunEngineContext};
use super::{
    Clock, Engine, EngineError, LoopIterationOutcome, NodeEvent, NodeStatus, RunEvent,
    RunEventRecord, RunReason, RunRecorder, RunState, RunStatus, StepRunResult, ValidatedBlock,
    ValidatedNode,
};
use crate::progress::{LiveEvent, ProgressSink};
use crate::state::CapturedValue;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(super) fn record_execution(
    node_state: &mut crate::Execution,
    attempt: u32,
    execution: &StepRunResult,
    stdout_path: &str,
    stderr_path: &str,
) {
    node_state.attempt = attempt;
    node_state.status = NodeStatus::Failed;
    node_state.started_at = Some(execution.started_at.clone());
    node_state.finished_at = Some(execution.finished_at.clone());
    node_state.duration_ms = Some(execution.duration_ms);
    node_state.exit_code = Some(execution.exit_code);
    node_state.stdout_path = Some(stdout_path.to_owned());
    node_state.stderr_path = Some(stderr_path.to_owned());
    node_state.stdout_preview = preview(&execution.stdout);
    node_state.stderr_preview = preview(&execution.stderr);
    node_state.stdout = Some(crate::state::CapturedValue::Text(execution.stdout.clone()));
    node_state.stderr = Some(execution.stderr.clone());
    node_state.result = None;
}

pub(super) fn mark_failed_to_start(node_state: &mut crate::Execution, attempt: u32, ts: String) {
    node_state.attempt = attempt;
    node_state.status = NodeStatus::Failed;
    node_state.started_at = Some(ts.clone());
    node_state.finished_at = Some(ts);
    node_state.duration_ms = Some(0);
    node_state.exit_code = None;
    node_state.stdout_path = None;
    node_state.stderr_path = None;
    node_state.stdout_preview.clear();
    node_state.stderr_preview.clear();
    node_state.stdout = None;
    node_state.stderr = None;
    node_state.result = None;
}

pub(super) fn mark_skipped(node_state: &mut crate::Execution, ts: &str) {
    node_state.attempt += 1;
    node_state.status = NodeStatus::Skipped;
    node_state.started_at = Some(ts.to_owned());
    node_state.finished_at = Some(ts.to_owned());
    node_state.duration_ms = Some(0);
    node_state.exit_code = None;
    node_state.stdout_path = None;
    node_state.stderr_path = None;
    node_state.stdout_preview.clear();
    node_state.stderr_preview.clear();
    node_state.stdout = None;
    node_state.stderr = None;
    node_state.result = None;
}

pub(super) fn mark_control_finished(
    node_state: &mut crate::Execution,
    attempt: u32,
    started_at: String,
    finished_at: String,
    status: NodeStatus,
    result: Option<CapturedValue>,
) {
    node_state.attempt = attempt;
    node_state.status = status;
    node_state.started_at = Some(started_at);
    node_state.finished_at = Some(finished_at);
    node_state.duration_ms = node_state
        .started_at
        .as_deref()
        .zip(node_state.finished_at.as_deref())
        .map(|(started_at, finished_at)| duration_ms_between(started_at, finished_at));
    node_state.exit_code = None;
    node_state.stdout_path = None;
    node_state.stderr_path = None;
    node_state.stdout_preview.clear();
    node_state.stderr_preview.clear();
    node_state.stdout = None;
    node_state.stderr = None;
    node_state.result = result;
}

fn duration_ms_between(started_at: &str, finished_at: &str) -> u128 {
    let Ok(started_at) = OffsetDateTime::parse(started_at, &Rfc3339) else {
        return 0;
    };
    let Ok(finished_at) = OffsetDateTime::parse(finished_at, &Rfc3339) else {
        return 0;
    };
    let elapsed = finished_at - started_at;
    if elapsed.is_negative() {
        return 0;
    }
    elapsed.whole_milliseconds() as u128
}

impl Engine {
    pub(super) fn record_loop_iteration_finished(
        &self,
        node: &ValidatedNode,
        iteration: u32,
        max_iterations: u32,
        outcome: LoopIterationOutcome,
        frame: &context::FrameContext,
        ctx: &mut RunEngineContext<'_>,
    ) -> Result<(), EngineError> {
        ctx.recorder.append_event(&RunEventRecord {
            ts: ctx.clock.now(),
            event: RunEvent::LoopIterationFinished {
                frame_id: frame.frame_id().clone(),
                node_path: node.path.clone(),
                user_id: node.user_id.clone(),
                iteration,
                max_iterations,
                outcome,
            },
        })?;
        ctx.progress.emit(LiveEvent::LoopIterationFinished {
            frame_id: frame.frame_id().clone(),
            node_path: node.path.clone(),
            user_id: node.user_id.clone(),
            iteration,
            max_iterations,
            outcome,
        });
        Ok(())
    }

    pub(super) fn finish_control_node(
        &self,
        state: &mut RunState,
        node: &ValidatedNode,
        finish: ControlNodeCompletion,
        frame: &context::FrameContext,
        ctx: &mut RunEngineContext<'_>,
    ) -> Result<(), EngineError> {
        let finished_at = ctx.clock.now();
        self.update_node_executions(state, frame, node, |current, frame_result| {
            mark_control_finished(
                current,
                finish.attempt,
                finish.started_at.clone(),
                finished_at.clone(),
                finish.status,
                finish.result.clone(),
            );
            mark_control_finished(
                frame_result,
                finish.attempt,
                finish.started_at,
                finished_at,
                finish.status,
                finish.result,
            );
        });
        self.record_node_finished(state, ctx.recorder, node, frame, ctx.clock, ctx.progress)
    }

    pub(super) fn record_branch_selected(
        &self,
        node: &ValidatedNode,
        case_index: usize,
        selection: crate::BranchSelection,
        frame: &context::FrameContext,
        ctx: &mut RunEngineContext<'_>,
    ) -> Result<(), EngineError> {
        ctx.recorder.append_event(&RunEventRecord {
            ts: ctx.clock.now(),
            event: RunEvent::BranchSelected {
                frame_id: frame.frame_id().clone(),
                node_path: node.path.clone(),
                user_id: node.user_id.clone(),
                case_index,
                selection,
            },
        })?;
        ctx.progress.emit(LiveEvent::BranchSelected {
            frame_id: frame.frame_id().clone(),
            node_path: node.path.clone(),
            user_id: node.user_id.clone(),
            case_index,
            selection,
        });
        Ok(())
    }

    pub(super) fn skip_non_selected_branch_cases(
        &self,
        branch_node: &crate::BranchNode,
        selected_case_index: usize,
        frame: &context::FrameContext,
        reason: &str,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
    ) -> Result<(), EngineError> {
        for (case_index, case) in branch_node.cases.iter().enumerate() {
            if case_index == selected_case_index {
                continue;
            }
            self.skip_block(&case.body, frame, reason, ctx, state)?;
        }
        Ok(())
    }

    pub(super) fn skip_branch_case_bodies(
        &self,
        branch_node: &crate::BranchNode,
        frame: &context::FrameContext,
        reason: &str,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
    ) -> Result<(), EngineError> {
        for case in &branch_node.cases {
            self.skip_block(&case.body, frame, reason, ctx, state)?;
        }
        Ok(())
    }

    pub(super) fn skip_parallel_branch_bodies(
        &self,
        parallel_node: &crate::ParallelNode,
        node_path: &crate::NodePath,
        frame: &context::FrameContext,
        reason: &str,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
    ) -> Result<(), EngineError> {
        for (branch_index, branch) in parallel_node.branches.iter().enumerate() {
            let branch_frame =
                context::FrameContext::for_parallel_branch(frame, node_path, branch_index);
            self.skip_block(&branch.body, &branch_frame, reason, ctx, state)?;
        }
        Ok(())
    }

    pub(super) fn skip_child_blocks(
        &self,
        node: &ValidatedNode,
        frame: &context::FrameContext,
        reason: &str,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
    ) -> Result<(), EngineError> {
        match &node.kind {
            crate::NodeKind::Action(_) => Ok(()),
            crate::NodeKind::Group(group_node) => {
                self.skip_block(&group_node.body, frame, reason, ctx, state)
            }
            crate::NodeKind::Loop(loop_node) => {
                self.skip_block(&loop_node.body, frame, reason, ctx, state)
            }
            crate::NodeKind::Branch(branch_node) => {
                self.skip_branch_case_bodies(branch_node, frame, reason, ctx, state)
            }
            crate::NodeKind::Parallel(parallel_node) => self.skip_parallel_branch_bodies(
                parallel_node,
                &node.path,
                frame,
                reason,
                ctx,
                state,
            ),
        }
    }

    pub(super) fn skip_block(
        &self,
        block: &ValidatedBlock,
        frame: &context::FrameContext,
        reason: &str,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
    ) -> Result<(), EngineError> {
        for node in &block.nodes {
            self.skip_node_tree(node, frame, reason, ctx, state)?;
        }
        Ok(())
    }

    pub(super) fn skip_node_tree(
        &self,
        node: &ValidatedNode,
        frame: &context::FrameContext,
        reason: &str,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
    ) -> Result<(), EngineError> {
        let skipped_at = ctx.clock.now();
        self.update_node_executions(state, frame, node, |current, frame_result| {
            mark_skipped(current, &skipped_at);
            mark_skipped(frame_result, &skipped_at);
        });
        ctx.recorder.append_event(&RunEventRecord {
            ts: ctx.clock.now(),
            event: RunEvent::NodeSkipped {
                frame_id: frame.frame_id().clone(),
                node_path: node.path.clone(),
                user_id: node.user_id.clone(),
                reason: reason.to_owned(),
            },
        })?;
        ctx.progress.emit(LiveEvent::NodeSkipped {
            frame_id: frame.frame_id().clone(),
            node_path: node.path.clone(),
            user_id: node.user_id.clone(),
            reason: reason.to_owned(),
        });
        self.skip_child_blocks(node, frame, reason, ctx, state)
    }

    pub(super) fn finish_run(
        &self,
        state: &mut RunState,
        recorder: &mut dyn RunRecorder,
        status: RunStatus,
        reason: RunReason,
        clock: &dyn Clock,
        progress: &mut dyn ProgressSink,
    ) -> Result<(), EngineError> {
        state.status = status;
        state.reason = Some(reason);
        state.finished_at = Some(clock.now());
        recorder.append_event(&RunEventRecord {
            ts: clock.now(),
            event: RunEvent::RunFinished { status, reason },
        })?;
        progress.emit(LiveEvent::RunFinished { status, reason });
        recorder.write_state(state)?;
        Ok(())
    }

    pub(super) fn record_node_finished(
        &self,
        state: &mut RunState,
        recorder: &mut dyn RunRecorder,
        node: &ValidatedNode,
        frame: &context::FrameContext,
        clock: &dyn Clock,
        progress: &mut dyn ProgressSink,
    ) -> Result<(), EngineError> {
        let (_, node_state) = self.node_executions_mut(state, frame, node);
        recorder.append_event(&RunEventRecord {
            ts: clock.now(),
            event: RunEvent::NodeFinished(Box::new(NodeEvent {
                frame_id: frame.frame_id().clone(),
                node_path: node.path.clone(),
                user_id: node.user_id.clone(),
                attempt: node_state.attempt,
                exit_code: node_state.exit_code,
                status: node_state.status,
                stdout_path: node_state.stdout_path.clone(),
                stderr_path: node_state.stderr_path.clone(),
                stdout_preview: node_state.stdout_preview.clone(),
                stderr_preview: node_state.stderr_preview.clone(),
                stdout: node_state.stdout.clone(),
                stderr: node_state.stderr.clone(),
                result: node_state.result.clone(),
            })),
        })?;
        progress.emit(LiveEvent::NodeFinished {
            frame_id: frame.frame_id().clone(),
            node_path: node.path.clone(),
            user_id: node.user_id.clone(),
            status: node_state.status,
            exit_code: node_state.exit_code,
            duration_ms: node_state.duration_ms,
            stdout_path: node_state.stdout_path.clone(),
            stderr_path: node_state.stderr_path.clone(),
        });
        recorder.write_state(state)?;
        Ok(())
    }

    pub(super) fn record_run_failure(
        &self,
        state: &mut RunState,
        recorder: &mut dyn RunRecorder,
        reason: RunReason,
        message: String,
        clock: &dyn Clock,
        progress: &mut dyn ProgressSink,
    ) -> Result<(), EngineError> {
        state.status = RunStatus::Failed;
        state.reason = Some(reason);
        state.finished_at = Some(clock.now());
        recorder.append_event(&RunEventRecord {
            ts: clock.now(),
            event: RunEvent::RunFailed { reason, message },
        })?;
        recorder.append_event(&RunEventRecord {
            ts: clock.now(),
            event: RunEvent::RunFinished { status: RunStatus::Failed, reason },
        })?;
        progress.emit(LiveEvent::RunFinished { status: RunStatus::Failed, reason });
        recorder.write_state(state)?;
        Ok(())
    }

    pub(super) fn next_attempt(&self, state: &RunState, node: &ValidatedNode) -> u32 {
        state.nodes.get(&node.path).map_or(1, |node_state| node_state.execution.attempt + 1)
    }

    pub(super) fn node_executions_mut<'a>(
        &self,
        state: &'a mut RunState,
        frame: &context::FrameContext,
        node: &ValidatedNode,
    ) -> (&'a mut crate::Execution, &'a mut crate::Execution) {
        let current = state.nodes.entry(node.path.clone()).or_insert_with(|| crate::NodeResult {
            node_path: node.path.clone(),
            execution: crate::Execution::pending(node.user_id.clone()),
        });
        let node_frames = &mut state.node_frames;
        let frame_key = (frame.frame_id().clone(), node.path.clone());
        let frame_state = node_frames.entry(frame_key).or_insert_with(|| {
            super::run_state::build_frame_result(
                frame.frame_id().clone(),
                node.path.clone(),
                node.user_id.clone(),
            )
        });
        (&mut current.execution, &mut frame_state.execution)
    }

    pub(super) fn update_node_executions(
        &self,
        state: &mut RunState,
        frame: &context::FrameContext,
        node: &ValidatedNode,
        update: impl FnOnce(&mut crate::Execution, &mut crate::Execution),
    ) {
        let (current, frame_result) = self.node_executions_mut(state, frame, node);
        update(current, frame_result);
    }
}
