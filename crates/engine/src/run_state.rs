use super::EngineError;
use crate::event::{RunReason, RunStatus};
use crate::ids::{FrameId, RunId};
use crate::state::{Execution, NodeFrameResult, NodeResult, RunState};
use crate::workflow::{NodeKind, ValidatedBlock, ValidatedWorkflow};
use std::collections::BTreeMap;

pub(super) fn build_initial_state(
    workflow: &ValidatedWorkflow,
    run_id: RunId,
    started_at: String,
) -> RunState {
    let mut nodes = BTreeMap::new();
    collect_node_results(&workflow.root, &mut nodes);

    RunState {
        run_id,
        workflow_id: workflow.id.clone(),
        status: RunStatus::Running,
        reason: None,
        started_at,
        finished_at: None,
        workflow_conversations: BTreeMap::new(),
        nodes,
        node_frames: BTreeMap::new(),
    }
}

fn collect_node_results(block: &ValidatedBlock, nodes: &mut BTreeMap<crate::NodePath, NodeResult>) {
    for node in &block.nodes {
        nodes.insert(
            node.path.clone(),
            NodeResult {
                node_path: node.path.clone(),
                execution: Execution::pending(node.user_id.clone()),
            },
        );

        match &node.kind {
            NodeKind::Action(_) => {}
            NodeKind::Group(group_node) => collect_node_results(&group_node.body, nodes),
            NodeKind::Loop(loop_node) => collect_node_results(&loop_node.body, nodes),
            NodeKind::Branch(branch_node) => {
                for case in &branch_node.cases {
                    collect_node_results(&case.body, nodes);
                }
            }
            NodeKind::Parallel(parallel_node) => {
                for branch in &parallel_node.branches {
                    collect_node_results(&branch.body, nodes);
                }
            }
        }
    }
}

pub(super) fn build_frame_result(
    frame_id: FrameId,
    node_path: crate::NodePath,
    user_id: Option<crate::StepId>,
) -> NodeFrameResult {
    NodeFrameResult { frame_id, node_path, execution: Execution::pending(user_id) }
}

pub(super) fn count_nodes(block: &ValidatedBlock) -> usize {
    block
        .nodes
        .iter()
        .map(|node| {
            1 + match &node.kind {
                NodeKind::Action(_) => 0,
                NodeKind::Group(group_node) => count_nodes(&group_node.body),
                NodeKind::Loop(loop_node) => count_nodes(&loop_node.body),
                NodeKind::Branch(branch_node) => {
                    branch_node.cases.iter().map(|case| count_nodes(&case.body)).sum()
                }
                NodeKind::Parallel(parallel_node) => {
                    parallel_node.branches.iter().map(|branch| count_nodes(&branch.body)).sum()
                }
            }
        })
        .sum()
}

pub(super) fn failure_reason(error: &EngineError) -> RunReason {
    match error {
        EngineError::Validation(_) => RunReason::ValidationError,
        EngineError::Evaluation(_) => RunReason::EvaluationError,
        EngineError::Recorder(_) => RunReason::EngineError,
        EngineError::Render(_) | EngineError::Result(_) => RunReason::StepFailed,
        EngineError::Executor(error) => error.run_reason(),
    }
}
