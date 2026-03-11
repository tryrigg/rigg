use super::context;
use super::conversations;
use super::error::eval_error;
use super::protocol::ExecutionPlan;
use super::result;
use super::{
    Clock, Engine, EngineError, LiveEvent, RunEvent, RunEventRecord, RunMeta, RunReason,
    RunRecorder, RunState, RunStatus, StepRunner, ValidatedBlock, ValidatedNode,
};
use crate::NodeStatus;
use crate::ids::{NodePath, StepId};
use crate::progress::{NoopProgressSink, ProgressSink};
use crate::state::CapturedValue;
use crate::workflow::NodeKind;
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

pub(super) struct RunEngineContext<'a> {
    pub(super) plan: &'a ExecutionPlan,
    pub(super) step_runner: &'a dyn StepRunner,
    pub(super) recorder: &'a mut dyn RunRecorder,
    pub(super) clock: &'a dyn Clock,
    pub(super) progress: &'a mut dyn ProgressSink,
    pub(super) conversations: conversations::ConversationState,
}

pub(super) struct ControlNodeCompletion {
    pub(super) attempt: u32,
    pub(super) started_at: String,
    pub(super) status: NodeStatus,
    pub(super) result: Option<CapturedValue>,
}

pub(super) struct NodeRunContext<'a> {
    pub(super) node_env: &'a BTreeMap<String, String>,
    pub(super) context: &'a JsonValue,
    pub(super) frame: &'a context::FrameContext,
}

#[derive(Debug)]
pub(super) enum ControlFlowOutcome {
    Completed { expose_public_result: bool, status: NodeStatus, result: Option<CapturedValue> },
}

impl Engine {
    pub fn run_plan(
        &self,
        plan: ExecutionPlan,
        step_runner: &dyn StepRunner,
        recorder: &mut dyn RunRecorder,
        clock: &dyn Clock,
    ) -> Result<RunState, EngineError> {
        let mut progress = NoopProgressSink;
        self.run_plan_with_progress(plan, step_runner, recorder, clock, &mut progress)
    }

    pub fn run_plan_with_progress(
        &self,
        plan: ExecutionPlan,
        step_runner: &dyn StepRunner,
        recorder: &mut dyn RunRecorder,
        clock: &dyn Clock,
        progress: &mut dyn ProgressSink,
    ) -> Result<RunState, EngineError> {
        let mut plan = plan;
        plan.invocation_inputs =
            result::normalize_invocation_inputs(&plan.workflow, &plan.invocation_inputs)?;
        let run_id = crate::RunId::new();
        let started_at = clock.now();
        let mut state = super::run_state::build_initial_state(
            &plan.workflow,
            run_id.clone(),
            started_at.clone(),
        );

        let meta = RunMeta {
            run_id: run_id.clone(),
            workflow_id: plan.workflow.id.clone(),
            cwd: plan.project_root.clone(),
            started_at: started_at.clone(),
            tool_version: plan.tool_version.clone(),
            config_hash: plan.config_hash.clone(),
            config_files: plan.config_files.clone(),
            invocation_inputs: plan.invocation_inputs.clone(),
        };
        recorder.init_run(&state, &meta)?;

        let node_count = super::run_state::count_nodes(&plan.workflow.root);
        recorder.append_event(&RunEventRecord {
            ts: started_at,
            event: RunEvent::RunStarted {
                run_id: run_id.clone(),
                workflow_id: plan.workflow.id.clone(),
                cwd: plan.project_root.clone(),
                node_count,
            },
        })?;
        progress.emit(LiveEvent::RunStarted {
            run_id,
            workflow_id: plan.workflow.id.clone(),
            node_count,
        });

        let mut ctx = RunEngineContext {
            plan: &plan,
            step_runner,
            recorder,
            clock,
            progress,
            conversations: conversations::ConversationState::default(),
        };
        let execution = self.run_initialized_plan(&mut ctx, &mut state);
        match execution {
            Ok(()) => Ok(state),
            Err(error) => {
                if matches!(error, EngineError::Recorder(_)) {
                    return Err(error);
                }
                self.record_run_failure(
                    &mut state,
                    ctx.recorder,
                    super::run_state::failure_reason(&error),
                    error.to_string(),
                    ctx.clock,
                    ctx.progress,
                )?;
                Err(error)
            }
        }
    }

    fn run_initialized_plan(
        &self,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
    ) -> Result<(), EngineError> {
        let mut visible_steps = BTreeMap::new();
        let frame = context::FrameContext::root();
        self.walk_block(&ctx.plan.workflow.root, ctx, state, &mut visible_steps, &frame)?;
        if !matches!(state.status, RunStatus::Running) {
            return Ok(());
        }
        self.finish_run(
            state,
            ctx.recorder,
            RunStatus::Succeeded,
            RunReason::Completed,
            ctx.clock,
            ctx.progress,
        )
    }

    pub(super) fn walk_block(
        &self,
        block: &ValidatedBlock,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
        visible_steps: &mut BTreeMap<StepId, NodePath>,
        frame: &context::FrameContext,
    ) -> Result<(), EngineError> {
        for node in &block.nodes {
            if self.execute_node(node, ctx, state, visible_steps, frame)? {
                self.expose_node(visible_steps, node);
            }
            if !matches!(state.status, RunStatus::Running) {
                return Ok(());
            }
        }

        Ok(())
    }

    fn execute_node(
        &self,
        node: &ValidatedNode,
        ctx: &mut RunEngineContext<'_>,
        state: &mut RunState,
        visible_steps: &mut BTreeMap<StepId, NodePath>,
        frame: &context::FrameContext,
    ) -> Result<bool, EngineError> {
        let node_env =
            super::render::render_env(ctx.plan, state, visible_steps, &node.attrs, frame)?;
        let context = context::build_context(ctx.plan, state, visible_steps, &node_env, frame);

        if let Some(condition) = &node.attrs.if_expr {
            match condition.evaluate(&context).map_err(eval_error)? {
                crate::expr::EvalOutcome::Bool(true) => {}
                crate::expr::EvalOutcome::Bool(false) => {
                    let skipped_at = ctx.clock.now();
                    self.update_node_executions(state, frame, node, |current, frame_result| {
                        super::record::mark_skipped(current, &skipped_at);
                        super::record::mark_skipped(frame_result, &skipped_at);
                    });
                    ctx.recorder.append_event(&RunEventRecord {
                        ts: ctx.clock.now(),
                        event: RunEvent::NodeSkipped {
                            frame_id: frame.frame_id().clone(),
                            node_path: node.path.clone(),
                            user_id: node.user_id.clone(),
                            reason: "condition evaluated to false".to_owned(),
                        },
                    })?;
                    ctx.progress.emit(LiveEvent::NodeSkipped {
                        frame_id: frame.frame_id().clone(),
                        node_path: node.path.clone(),
                        user_id: node.user_id.clone(),
                        reason: "condition evaluated to false".to_owned(),
                    });
                    self.skip_child_blocks(
                        node,
                        frame,
                        "ancestor condition evaluated to false",
                        ctx,
                        state,
                    )?;
                    ctx.recorder.write_state(state)?;
                    return Ok(false);
                }
                _ => unreachable!("boolean expressions always return bool"),
            }
        }

        match &node.kind {
            NodeKind::Action(action) => self.execute_action_node(
                node,
                action,
                NodeRunContext { node_env: &node_env, context: &context, frame },
                ctx,
                state,
            ),
            NodeKind::Group(group_node) => self.execute_group_node(
                node,
                group_node,
                NodeRunContext { node_env: &node_env, context: &context, frame },
                ctx,
                state,
                visible_steps,
            ),
            NodeKind::Loop(loop_node) => self.execute_loop_node(
                node,
                loop_node,
                NodeRunContext { node_env: &node_env, context: &context, frame },
                ctx,
                state,
                visible_steps,
            ),
            NodeKind::Branch(branch_node) => self.execute_branch_node(
                node,
                branch_node,
                NodeRunContext { node_env: &node_env, context: &context, frame },
                ctx,
                state,
                visible_steps,
            ),
            NodeKind::Parallel(parallel_node) => self.execute_parallel_node(
                node,
                parallel_node,
                NodeRunContext { node_env: &node_env, context: &context, frame },
                ctx,
                state,
                visible_steps,
            ),
        }
    }

    pub(super) fn expose_node(
        &self,
        visible_steps: &mut BTreeMap<StepId, NodePath>,
        node: &ValidatedNode,
    ) {
        if let Some(user_id) = &node.user_id {
            visible_steps.insert(user_id.clone(), node.path.clone());
        }
    }
}
