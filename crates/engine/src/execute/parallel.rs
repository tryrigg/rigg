use super::super::runner::{
    ControlFlowOutcome, ControlNodeCompletion, NodeRunContext, RunEngineContext,
};
use super::{
    Engine, EngineError, ExecutorError, LiveEvent, NodeStatus, ParallelBranchCompletion,
    ParallelBranchEmitter, ParallelBranchMessage, ParallelBranchProgress, ParallelBranchRecorder,
    ParallelBranchTask, RunEvent, RunEventRecord, RunState, RunStatus, context,
    merge_parallel_branch_state, resolve_buffered_log_path,
    rewrite_buffered_progress_event_log_paths, rewrite_buffered_run_event_log_paths,
    rewrite_parallel_branch_state_log_paths,
};
use crate::ids::StepId;
use crate::workflow::{ParallelNode, ValidatedNode};
use std::collections::BTreeMap;
use std::sync::mpsc;
use std::thread;

impl Engine {
    pub(crate) fn execute_parallel_node(
        &self,
        node: &ValidatedNode,
        parallel_node: &ParallelNode,
        exec: NodeRunContext<'_>,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
        visible_steps: &BTreeMap<StepId, crate::NodePath>,
    ) -> Result<bool, EngineError> {
        let attempt = self.next_attempt(state, node);
        let started_at = ctx.clock.now();
        ctx.recorder.append_event(&RunEventRecord {
            ts: started_at.clone(),
            event: RunEvent::NodeStarted {
                frame_id: exec.frame.frame_id().clone(),
                node_path: node.path.clone(),
                user_id: node.user_id.clone(),
                node_kind: node.kind.label().to_owned(),
                attempt,
                command: node.kind.label().to_owned(),
            },
        })?;
        ctx.progress.emit(LiveEvent::NodeStarted {
            frame_id: exec.frame.frame_id().clone(),
            node_path: node.path.clone(),
            user_id: node.user_id.clone(),
            node_kind: node.kind.label().to_owned(),
            provider: None,
            attempt,
        });

        let mut branch_failed = false;
        let mut branch_error: Option<EngineError> = None;
        let outcome = (|| -> Result<ControlFlowOutcome, EngineError> {
            let mut export_visible = visible_steps.clone();
            let incoming_conversations = ctx.conversations.clone();
            let progress_enabled = ctx.progress.is_enabled();
            let run_artifacts_dir = ctx.recorder.run_artifacts_dir()?;
            let mut replay_error = None;
            let mut resolved_log_paths = BTreeMap::new();

            thread::scope(|scope| {
                let (tx, rx) = mpsc::channel();

                for (branch_index, branch) in parallel_node.branches.iter().enumerate() {
                    let incoming_conversations = incoming_conversations.clone();
                    let emitter = ParallelBranchEmitter::new(tx.clone());
                    let task = ParallelBranchTask {
                        branch_index,
                        branch,
                        node_path: &node.path,
                        parent_frame: exec.frame,
                        plan: ctx.plan,
                        step_runner: ctx.step_runner,
                        clock: ctx.clock,
                        branch_state: state.clone(),
                        branch_visible: visible_steps.clone(),
                        run_artifacts_dir: run_artifacts_dir.clone(),
                        conversations: incoming_conversations,
                        progress_enabled,
                        emitter,
                    };
                    scope.spawn(move || {
                        self.execute_parallel_branch(task);
                    });
                }
                drop(tx);

                let mut completed_branches = 0usize;
                while completed_branches < parallel_node.branches.len() {
                    let message = match rx.recv() {
                        Ok(message) => message,
                        Err(_) => {
                            replay_error = Some(EngineError::Executor(ExecutorError::RunTool {
                                program: "parallel-branch".to_owned(),
                                source: std::io::Error::other(
                                    "parallel branch worker terminated before reporting a message",
                                ),
                            }));
                            break;
                        }
                    };

                    match message {
                        ParallelBranchMessage::Event(mut event) => {
                            if replay_error.is_some() {
                                continue;
                            }
                            rewrite_buffered_run_event_log_paths(&mut event, &resolved_log_paths);
                            if let Err(error) = ctx.recorder.append_event(&event) {
                                replay_error = Some(error);
                            }
                        }
                        ParallelBranchMessage::Log(log) => {
                            if replay_error.is_some() {
                                continue;
                            }
                            let path = resolve_buffered_log_path(
                                ctx.recorder,
                                &mut resolved_log_paths,
                                &log,
                            );
                            if let Err(error) = ctx.recorder.append_log(&path, &log.chunk) {
                                replay_error = Some(error);
                            }
                        }
                        ParallelBranchMessage::Progress(mut event) => {
                            if replay_error.is_some() {
                                continue;
                            }
                            rewrite_buffered_progress_event_log_paths(
                                &mut event,
                                &resolved_log_paths,
                            );
                            ctx.progress.emit(event);
                        }
                        ParallelBranchMessage::StateCheckpoint {
                            branch_index,
                            mut branch_state,
                        } => {
                            if replay_error.is_some() {
                                continue;
                            }
                            let branch = &parallel_node.branches[branch_index];
                            rewrite_parallel_branch_state_log_paths(
                                &mut branch_state,
                                &branch.body,
                                &resolved_log_paths,
                            );
                            merge_parallel_branch_state(state, &branch_state, &branch.body);
                            if let Err(error) = ctx.recorder.write_state(state) {
                                replay_error = Some(error);
                            }
                        }
                        ParallelBranchMessage::Completed(mut completion) => {
                            completed_branches += 1;
                            if replay_error.is_some() {
                                continue;
                            }

                            let branch = &parallel_node.branches[completion.branch_index];
                            rewrite_parallel_branch_state_log_paths(
                                &mut completion.branch_state,
                                &branch.body,
                                &resolved_log_paths,
                            );

                            merge_parallel_branch_state(
                                state,
                                &completion.branch_state,
                                &branch.body,
                            );
                            if let Err(error) = ctx.conversations.merge_parallel_branch(
                                state,
                                &incoming_conversations,
                                &completion.branch_conversations,
                            ) {
                                branch_failed = true;
                                if branch_error.is_none() {
                                    branch_error = Some(error.into());
                                }
                            }

                            if let Err(error) = ctx.recorder.write_state(state) {
                                replay_error = Some(error);
                                continue;
                            }

                            match completion.branch_result {
                                Ok(())
                                    if matches!(
                                        completion.branch_state.status,
                                        RunStatus::Running
                                    ) =>
                                {
                                    for (step_id, path) in &completion.branch_visible {
                                        if !visible_steps.contains_key(step_id) {
                                            export_visible.insert(step_id.clone(), path.clone());
                                        }
                                    }
                                }
                                Ok(()) => {
                                    branch_failed = true;
                                }
                                Err(error) => {
                                    branch_failed = true;
                                    if matches!(error, EngineError::Recorder(_)) {
                                        replay_error = Some(error);
                                        continue;
                                    }
                                    if branch_error.is_none() {
                                        branch_error = Some(error);
                                    }
                                }
                            }
                        }
                    }
                }
            });

            if let Some(error) = replay_error.take() {
                return Err(error);
            }

            if let Some(error) = branch_error.take() {
                return Err(error);
            }

            if branch_failed {
                return Ok(ControlFlowOutcome::Completed {
                    expose_public_result: false,
                    status: NodeStatus::Failed,
                    result: None,
                });
            }

            let parallel_context =
                context::build_context(ctx.plan, state, &export_visible, exec.node_env, exec.frame);
            let result = parallel_node
                .exports
                .as_ref()
                .map(|exports| self.evaluate_export_spec(exports, &parallel_context))
                .transpose()?
                .flatten();

            Ok(ControlFlowOutcome::Completed {
                expose_public_result: parallel_node.exports.is_some(),
                status: NodeStatus::Succeeded,
                result,
            })
        })();

        match outcome {
            Ok(ControlFlowOutcome::Completed { expose_public_result, status, result }) => {
                self.finish_control_node(
                    state,
                    node,
                    ControlNodeCompletion { attempt, started_at, status, result },
                    exec.frame,
                    ctx,
                )?;
                if branch_failed {
                    self.finish_run(
                        state,
                        ctx.recorder,
                        RunStatus::Failed,
                        crate::RunReason::StepFailed,
                        ctx.clock,
                        ctx.progress,
                    )?;
                    return Ok(false);
                }
                Ok(expose_public_result)
            }
            Err(error) => {
                self.finish_control_node(
                    state,
                    node,
                    ControlNodeCompletion {
                        attempt,
                        started_at,
                        status: NodeStatus::Failed,
                        result: None,
                    },
                    exec.frame,
                    ctx,
                )?;
                Err(error)
            }
        }
    }

    fn execute_parallel_branch(&self, task: ParallelBranchTask<'_>) {
        let ParallelBranchTask {
            branch_index,
            branch,
            node_path,
            parent_frame,
            plan,
            step_runner,
            clock,
            mut branch_state,
            mut branch_visible,
            run_artifacts_dir,
            conversations,
            progress_enabled,
            emitter,
        } = task;
        let branch_frame =
            context::FrameContext::for_parallel_branch(parent_frame, node_path, branch_index);
        branch_state.status = RunStatus::Running;
        branch_state.reason = None;
        branch_state.finished_at = None;

        let mut branch_recorder =
            ParallelBranchRecorder::new(branch_index, run_artifacts_dir, emitter.clone());
        let mut branch_progress = ParallelBranchProgress::new(progress_enabled, emitter.clone());
        let mut branch_ctx = RunEngineContext {
            plan,
            step_runner,
            recorder: &mut branch_recorder,
            clock,
            progress: &mut branch_progress,
            conversations,
        };
        let branch_result = self.walk_block(
            &branch.body,
            &mut branch_ctx,
            &mut branch_state,
            &mut branch_visible,
            &branch_frame,
        );

        let _ = emitter.send(ParallelBranchMessage::Completed(ParallelBranchCompletion {
            branch_index,
            branch_result,
            branch_state,
            branch_visible,
            branch_conversations: branch_ctx.conversations,
        }));
    }
}
