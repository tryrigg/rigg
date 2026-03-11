use super::super::runner::{
    ControlFlowOutcome, ControlNodeCompletion, NodeRunContext, RunEngineContext,
};
use super::{
    Engine, EngineError, LiveEvent, NodeStatus, RunEvent, RunEventRecord, RunState, RunStatus,
    context,
};
use crate::ids::StepId;
use crate::workflow::{GroupNode, ValidatedNode};
use std::collections::BTreeMap;

impl Engine {
    pub(crate) fn execute_group_node(
        &self,
        node: &ValidatedNode,
        group_node: &GroupNode,
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
            let mut group_visible = visible_steps.clone();
            self.walk_block(&group_node.body, ctx, state, &mut group_visible, exec.frame)?;
            if !matches!(state.status, RunStatus::Running) {
                return Ok(ControlFlowOutcome::Completed {
                    expose_public_result: false,
                    status: NodeStatus::Failed,
                    result: None,
                });
            }

            let group_context =
                context::build_context(ctx.plan, state, &group_visible, exec.node_env, exec.frame);
            let result = group_node
                .exports
                .as_ref()
                .map(|exports| self.evaluate_export_spec(exports, &group_context))
                .transpose()?
                .flatten();

            Ok(ControlFlowOutcome::Completed {
                expose_public_result: group_node.exports.is_some(),
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
