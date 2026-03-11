use super::protocol::ExecutionPlan;
use crate::RunState;
use crate::ids::{FrameId, LoopScopeId, NodePath, StepId};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) struct FrameContext {
    frame_id: FrameId,
    iteration_frame_id: FrameId,
    loop_scope_id: Option<LoopScopeId>,
    loop_frame: Option<LoopFrame>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LoopFrame {
    pub node_path: NodePath,
    pub iteration: u32,
    pub max_iterations: u32,
}

impl FrameContext {
    pub(super) fn root() -> Self {
        Self {
            frame_id: FrameId::root(),
            iteration_frame_id: FrameId::root(),
            loop_scope_id: None,
            loop_frame: None,
        }
    }

    pub(super) fn frame_id(&self) -> &FrameId {
        &self.frame_id
    }

    pub(super) fn iteration_frame_id(&self) -> &FrameId {
        &self.iteration_frame_id
    }

    pub(super) fn loop_scope_id(&self) -> Option<&LoopScopeId> {
        self.loop_scope_id.as_ref()
    }

    pub(super) fn child_loop_scope_id(&self, node_path: &NodePath) -> LoopScopeId {
        self.frame_id.child_loop_scope(node_path)
    }

    pub(super) fn for_loop_iteration(
        parent: &Self,
        node_path: &NodePath,
        iteration: u32,
        max_iterations: u32,
    ) -> Self {
        let loop_scope_id = parent.child_loop_scope_id(node_path);
        let frame_id = FrameId::for_loop_iteration(&loop_scope_id, iteration);
        Self {
            frame_id: frame_id.clone(),
            iteration_frame_id: frame_id,
            loop_scope_id: Some(loop_scope_id),
            loop_frame: Some(LoopFrame { node_path: node_path.clone(), iteration, max_iterations }),
        }
    }

    pub(super) fn for_parallel_branch(
        parent: &Self,
        node_path: &NodePath,
        branch_index: usize,
    ) -> Self {
        Self {
            frame_id: FrameId::for_parallel_branch(parent.frame_id(), node_path, branch_index),
            iteration_frame_id: parent.iteration_frame_id.clone(),
            loop_scope_id: parent.loop_scope_id.clone(),
            loop_frame: parent.loop_frame.clone(),
        }
    }
}

pub(super) fn build_context(
    plan: &ExecutionPlan,
    state: &RunState,
    visible_steps: &BTreeMap<StepId, NodePath>,
    env: &BTreeMap<String, String>,
    frame: &FrameContext,
) -> JsonValue {
    JsonValue::Object(JsonMap::from_iter([
        ("inputs".to_owned(), plan.invocation_inputs.clone()),
        ("steps".to_owned(), steps_json(state, visible_steps)),
        ("env".to_owned(), env_json(env)),
        ("run".to_owned(), run_json(frame)),
    ]))
}

fn steps_json(state: &RunState, visible_steps: &BTreeMap<StepId, NodePath>) -> JsonValue {
    JsonValue::Object(
        visible_steps
            .iter()
            .map(|(step_id, path)| {
                let result = state
                    .nodes
                    .get(path)
                    .and_then(|node| node.execution.result.as_ref())
                    .map_or(JsonValue::Null, crate::CapturedValue::as_json);
                (
                    step_id.to_string(),
                    JsonValue::Object(JsonMap::from_iter([("result".to_owned(), result)])),
                )
            })
            .collect(),
    )
}

fn env_json(env: &BTreeMap<String, String>) -> JsonValue {
    JsonValue::Object(
        env.iter().map(|(key, value)| (key.clone(), JsonValue::String(value.clone()))).collect(),
    )
}

fn run_json(frame: &FrameContext) -> JsonValue {
    let mut run = JsonMap::new();
    if let Some(loop_frame) = &frame.loop_frame {
        run.insert("iteration".to_owned(), JsonValue::from(loop_frame.iteration));
        run.insert("max_iterations".to_owned(), JsonValue::from(loop_frame.max_iterations));
        run.insert("node_path".to_owned(), JsonValue::String(loop_frame.node_path.to_string()));
    }
    JsonValue::Object(run)
}
