use super::super::runner::{
    ControlFlowOutcome, ControlNodeCompletion, NodeRunContext, RunEngineContext,
};
use super::{
    Engine, EngineError, LiveEvent, NodeStatus, RunEvent, RunEventRecord, RunState, RunStatus,
    branch_selection, context,
};
use crate::ids::StepId;
use crate::workflow::{BranchNode, ValidatedNode};
use std::collections::BTreeMap;

impl Engine {
    pub(crate) fn execute_branch_node(
        &self,
        node: &ValidatedNode,
        branch_node: &BranchNode,
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
            for (case_index, case) in branch_node.cases.iter().enumerate() {
                if !self.branch_case_matches(case, exec.context)? {
                    continue;
                }

                self.record_branch_selected(
                    node,
                    case_index,
                    branch_selection(case),
                    exec.frame,
                    ctx,
                )?;
                self.skip_non_selected_branch_cases(
                    branch_node,
                    case_index,
                    exec.frame,
                    "branch case not selected",
                    ctx,
                    state,
                )?;

                let mut branch_visible = visible_steps.clone();
                self.walk_block(&case.body, ctx, state, &mut branch_visible, exec.frame)?;
                if !matches!(state.status, RunStatus::Running) {
                    return Ok(ControlFlowOutcome::Completed {
                        expose_public_result: false,
                        status: NodeStatus::Failed,
                        result: None,
                    });
                }

                let branch_context = context::build_context(
                    ctx.plan,
                    state,
                    &branch_visible,
                    exec.node_env,
                    exec.frame,
                );
                let result = case
                    .exports
                    .as_ref()
                    .map(|exports| self.evaluate_export_spec(exports, &branch_context))
                    .transpose()?
                    .flatten();

                return Ok(ControlFlowOutcome::Completed {
                    expose_public_result: case.exports.is_some(),
                    status: NodeStatus::Succeeded,
                    result,
                });
            }

            self.skip_branch_case_bodies(
                branch_node,
                exec.frame,
                "no branch case matched",
                ctx,
                state,
            )?;
            Ok(ControlFlowOutcome::Completed {
                expose_public_result: false,
                status: NodeStatus::Skipped,
                result: None,
            })
        })();

        match outcome {
            Ok(ControlFlowOutcome::Completed { expose_public_result, status, result }) => {
                if status == NodeStatus::Skipped {
                    let skipped_at = ctx.clock.now();
                    self.update_node_executions(
                        state,
                        exec.frame,
                        node,
                        |current, frame_result| {
                            super::super::record::mark_skipped(current, &skipped_at);
                            super::super::record::mark_skipped(frame_result, &skipped_at);
                        },
                    );
                    ctx.recorder.append_event(&RunEventRecord {
                        ts: ctx.clock.now(),
                        event: RunEvent::NodeSkipped {
                            frame_id: exec.frame.frame_id().clone(),
                            node_path: node.path.clone(),
                            user_id: node.user_id.clone(),
                            reason: "no branch case matched".to_owned(),
                        },
                    })?;
                    ctx.progress.emit(LiveEvent::NodeSkipped {
                        frame_id: exec.frame.frame_id().clone(),
                        node_path: node.path.clone(),
                        user_id: node.user_id.clone(),
                        reason: "no branch case matched".to_owned(),
                    });
                    ctx.recorder.write_state(state)?;
                    return Ok(false);
                }

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
