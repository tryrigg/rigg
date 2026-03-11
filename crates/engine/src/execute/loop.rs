use super::super::error::eval_error;
use super::super::runner::{
    ControlFlowOutcome, ControlNodeCompletion, NodeRunContext, RunEngineContext,
};
use super::{
    Engine, EngineError, ExecutorError, LiveEvent, LoopIterationOutcome, NodeStatus, RunEvent,
    RunEventRecord, RunState, RunStatus, context,
};
use crate::ids::StepId;
use crate::workflow::{LoopNode, ValidatedNode};
use std::collections::BTreeMap;

impl Engine {
    pub(crate) fn execute_loop_node(
        &self,
        node: &ValidatedNode,
        loop_node: &LoopNode,
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

        let outcome = (|| -> Result<ControlFlowOutcome, EngineError> {
            for iteration in 1..=loop_node.max {
                let loop_frame = context::FrameContext::for_loop_iteration(
                    exec.frame,
                    &node.path,
                    iteration,
                    loop_node.max,
                );
                ctx.recorder.append_event(&RunEventRecord {
                    ts: ctx.clock.now(),
                    event: RunEvent::LoopIterationStarted {
                        frame_id: loop_frame.frame_id().clone(),
                        node_path: node.path.clone(),
                        user_id: node.user_id.clone(),
                        iteration,
                        max_iterations: loop_node.max,
                    },
                })?;
                ctx.progress.emit(LiveEvent::LoopIterationStarted {
                    frame_id: loop_frame.frame_id().clone(),
                    node_path: node.path.clone(),
                    user_id: node.user_id.clone(),
                    iteration,
                    max_iterations: loop_node.max,
                });

                let mut loop_visible = visible_steps.clone();
                let (iteration_outcome, next) = if let Err(error) =
                    self.walk_block(&loop_node.body, ctx, state, &mut loop_visible, &loop_frame)
                {
                    (LoopIterationOutcome::Failed, Err(error))
                } else if !matches!(state.status, RunStatus::Running) {
                    (
                        LoopIterationOutcome::Failed,
                        Ok(Some(ControlFlowOutcome::Completed {
                            expose_public_result: false,
                            status: NodeStatus::Failed,
                            result: None,
                        })),
                    )
                } else {
                    let loop_context = context::build_context(
                        ctx.plan,
                        state,
                        &loop_visible,
                        exec.node_env,
                        &loop_frame,
                    );
                    match loop_node.until.evaluate(&loop_context) {
                        Ok(crate::expr::EvalOutcome::Bool(true)) => match loop_node
                            .exports
                            .as_ref()
                            .map(|exports| self.evaluate_export_spec(exports, &loop_context))
                            .transpose()
                        {
                            Ok(result) => (
                                LoopIterationOutcome::Completed,
                                Ok(Some(ControlFlowOutcome::Completed {
                                    expose_public_result: loop_node.exports.is_some(),
                                    status: NodeStatus::Succeeded,
                                    result: result.flatten(),
                                })),
                            ),
                            Err(error) => (LoopIterationOutcome::Failed, Err(error)),
                        },
                        Ok(crate::expr::EvalOutcome::Bool(false)) => {
                            (LoopIterationOutcome::Continue, Ok(None))
                        }
                        Ok(_) => unreachable!("boolean expressions always return bool"),
                        Err(error) => (LoopIterationOutcome::Failed, Err(eval_error(error))),
                    }
                };

                ctx.conversations.clear_iteration(&loop_frame);
                self.record_loop_iteration_finished(
                    node,
                    iteration,
                    loop_node.max,
                    iteration_outcome,
                    &loop_frame,
                    ctx,
                )?;
                match next {
                    Ok(Some(outcome)) => return Ok(outcome),
                    Ok(None) => {}
                    Err(error) => return Err(error),
                }
            }

            Err(EngineError::Executor(ExecutorError::LoopExhausted {
                node: node
                    .user_id
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| node.path.to_string()),
                max_iterations: loop_node.max,
            }))
        })();
        ctx.conversations.clear_loop(&exec.frame.child_loop_scope_id(&node.path));
        match outcome {
            Ok(ControlFlowOutcome::Completed { expose_public_result, status, result }) => {
                self.finish_control_node(
                    state,
                    node,
                    ControlNodeCompletion { attempt, started_at, status, result },
                    exec.frame,
                    ctx,
                )?;
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
}
