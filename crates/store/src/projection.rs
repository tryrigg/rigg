use crate::record::{
    BranchSelection, ConversationSnapshot, Event, EventRecord, LoopIterationOutcome, NodeRecord,
    NodeSnapshot, NodeStatus, RunFinished, RunReason, RunSnapshot, RunStatus,
};
use rigg_core::{
    CapturedValue, ConversationHandle, NodeEvent, RunEvent, RunEventRecord, RunMeta, RunState,
};

impl From<&RunMeta> for crate::Meta {
    fn from(meta: &RunMeta) -> Self {
        Self {
            run_id: meta.run_id.to_string(),
            workflow_id: meta.workflow_id.to_string(),
            cwd: meta.cwd.display().to_string(),
            started_at: meta.started_at.clone(),
            tool_version: meta.tool_version.clone(),
            config_hash: meta.config_hash.clone(),
            config_files: meta.config_files.iter().map(|path| path.display().to_string()).collect(),
            invocation_inputs: meta.invocation_inputs.clone(),
        }
    }
}

impl From<&RunEventRecord> for EventRecord {
    fn from(record: &RunEventRecord) -> Self {
        Self { ts: record.ts.clone(), event: Event::from(&record.event) }
    }
}

impl From<&RunState> for RunSnapshot {
    fn from(state: &RunState) -> Self {
        Self {
            run_id: state.run_id.to_string(),
            workflow_id: state.workflow_id.to_string(),
            status: RunStatus::from(state.status),
            reason: state.reason.map(RunReason::from),
            started_at: state.started_at.clone(),
            finished_at: state.finished_at.clone(),
            conversations: state
                .workflow_conversations
                .iter()
                .map(|(name, handle)| (name.to_string(), ConversationSnapshot::from(handle)))
                .collect(),
            nodes: state.nodes.values().map(NodeSnapshot::from).collect(),
        }
    }
}

impl From<&RunEvent> for Event {
    fn from(event: &RunEvent) -> Self {
        match event {
            RunEvent::RunStarted { run_id, workflow_id, cwd, node_count } => Self::RunStarted {
                run_id: run_id.to_string(),
                workflow_id: workflow_id.to_string(),
                cwd: cwd.display().to_string(),
                node_count: *node_count,
            },
            RunEvent::NodeStarted { frame_id, node_path, user_id, node_kind, attempt, command } => {
                Self::NodeStarted {
                    frame_id: frame_id.to_string(),
                    node_path: node_path.to_string(),
                    user_id: user_id.as_ref().map(ToString::to_string),
                    node_kind: node_kind.clone(),
                    attempt: *attempt,
                    command: command.clone(),
                }
            }
            RunEvent::NodeSkipped { frame_id, node_path, user_id, reason } => Self::NodeSkipped {
                frame_id: frame_id.to_string(),
                node_path: node_path.to_string(),
                user_id: user_id.as_ref().map(ToString::to_string),
                reason: reason.clone(),
            },
            RunEvent::BranchSelected { frame_id, node_path, user_id, case_index, selection } => {
                Self::BranchSelected {
                    frame_id: frame_id.to_string(),
                    node_path: node_path.to_string(),
                    user_id: user_id.as_ref().map(ToString::to_string),
                    case_index: *case_index,
                    selection: BranchSelection::from(*selection),
                }
            }
            RunEvent::LoopIterationStarted {
                frame_id,
                node_path,
                user_id,
                iteration,
                max_iterations,
            } => Self::LoopIterationStarted {
                frame_id: frame_id.to_string(),
                node_path: node_path.to_string(),
                user_id: user_id.as_ref().map(ToString::to_string),
                iteration: *iteration,
                max_iterations: *max_iterations,
            },
            RunEvent::LoopIterationFinished {
                frame_id,
                node_path,
                user_id,
                iteration,
                max_iterations,
                outcome,
            } => Self::LoopIterationFinished {
                frame_id: frame_id.to_string(),
                node_path: node_path.to_string(),
                user_id: user_id.as_ref().map(ToString::to_string),
                iteration: *iteration,
                max_iterations: *max_iterations,
                outcome: LoopIterationOutcome::from(*outcome),
            },
            RunEvent::NodeFinished(node) => {
                Self::NodeFinished(Box::new(NodeRecord::from(node.as_ref())))
            }
            RunEvent::RunFinished { status, reason } => Self::RunFinished(RunFinished {
                status: RunStatus::from(*status),
                reason: RunReason::from(*reason),
            }),
            RunEvent::RunFailed { reason, message } => {
                Self::RunFailed { reason: RunReason::from(*reason), message: message.clone() }
            }
        }
    }
}

impl From<&rigg_core::NodeResult> for NodeSnapshot {
    fn from(node: &rigg_core::NodeResult) -> Self {
        Self {
            node_path: node.node_path.to_string(),
            user_id: node.execution.user_id.as_ref().map(ToString::to_string),
            attempt: node.execution.attempt,
            status: NodeStatus::from(node.execution.status),
            started_at: node.execution.started_at.clone(),
            finished_at: node.execution.finished_at.clone(),
            duration_ms: node.execution.duration_ms,
            exit_code: node.execution.exit_code,
            stdout_path: node.execution.stdout_path.clone(),
            stderr_path: node.execution.stderr_path.clone(),
            stdout_preview: node.execution.stdout_preview.clone(),
            stderr_preview: node.execution.stderr_preview.clone(),
            stdout: node.execution.stdout.as_ref().map(projected_value),
            stderr: node.execution.stderr.clone(),
            result: node.execution.result.as_ref().map(projected_value),
        }
    }
}

impl From<&NodeEvent> for NodeRecord {
    fn from(node: &NodeEvent) -> Self {
        Self {
            frame_id: node.frame_id.to_string(),
            node_path: node.node_path.to_string(),
            user_id: node.user_id.as_ref().map(ToString::to_string),
            attempt: node.attempt,
            exit_code: node.exit_code,
            status: NodeStatus::from(node.status),
            stdout_path: node.stdout_path.clone(),
            stderr_path: node.stderr_path.clone(),
            stdout_preview: node.stdout_preview.clone(),
            stderr_preview: node.stderr_preview.clone(),
            stdout: node.stdout.as_ref().map(projected_value),
            stderr: node.stderr.clone(),
            result: node.result.as_ref().map(projected_value),
        }
    }
}

impl From<rigg_core::RunStatus> for RunStatus {
    fn from(status: rigg_core::RunStatus) -> Self {
        match status {
            rigg_core::RunStatus::Running => Self::Running,
            rigg_core::RunStatus::Succeeded => Self::Succeeded,
            rigg_core::RunStatus::Failed => Self::Failed,
        }
    }
}

fn projected_value(value: &CapturedValue) -> serde_json::Value {
    match value {
        CapturedValue::Text(text) => serde_json::Value::String(text.clone()),
        CapturedValue::Json(json) => json.clone(),
    }
}

impl From<rigg_core::RunReason> for RunReason {
    fn from(reason: rigg_core::RunReason) -> Self {
        match reason {
            rigg_core::RunReason::Completed => Self::Completed,
            rigg_core::RunReason::StepFailed => Self::StepFailed,
            rigg_core::RunReason::StepTimedOut => Self::StepTimedOut,
            rigg_core::RunReason::EvaluationError => Self::EvaluationError,
            rigg_core::RunReason::EngineError => Self::EngineError,
            rigg_core::RunReason::ValidationError => Self::ValidationError,
        }
    }
}

impl From<rigg_core::NodeStatus> for NodeStatus {
    fn from(status: rigg_core::NodeStatus) -> Self {
        match status {
            rigg_core::NodeStatus::Pending => Self::Pending,
            rigg_core::NodeStatus::Skipped => Self::Skipped,
            rigg_core::NodeStatus::Succeeded => Self::Succeeded,
            rigg_core::NodeStatus::Failed => Self::Failed,
        }
    }
}

impl From<rigg_core::LoopIterationOutcome> for LoopIterationOutcome {
    fn from(outcome: rigg_core::LoopIterationOutcome) -> Self {
        match outcome {
            rigg_core::LoopIterationOutcome::Continue => Self::Continue,
            rigg_core::LoopIterationOutcome::Completed => Self::Completed,
            rigg_core::LoopIterationOutcome::Failed => Self::Failed,
        }
    }
}

impl From<rigg_core::BranchSelection> for BranchSelection {
    fn from(selection: rigg_core::BranchSelection) -> Self {
        match selection {
            rigg_core::BranchSelection::If => Self::If,
            rigg_core::BranchSelection::Else => Self::Else,
        }
    }
}

impl From<&ConversationHandle> for ConversationSnapshot {
    fn from(handle: &ConversationHandle) -> Self {
        match handle {
            ConversationHandle::Claude { session_id } => {
                Self::Claude { session_id: session_id.clone() }
            }
            ConversationHandle::Codex { thread_id } => Self::Codex { thread_id: thread_id.clone() },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Event, RunSnapshot};
    use rigg_core::{
        Execution, FrameId, NodeFrameResult, NodePath, NodeResult, NodeStatus, RunEvent, RunId,
        RunState, RunStatus, WorkflowId,
    };
    use std::collections::BTreeMap;

    #[test]
    fn snapshots_preserve_structural_node_order() -> Result<(), Box<dyn std::error::Error>> {
        let mut nodes = BTreeMap::new();
        for path in ["/10", "/2", "/1/10", "/1/2"] {
            let node_path = NodePath::try_from(path)?;
            nodes.insert(
                node_path.clone(),
                NodeResult {
                    node_path,
                    execution: Execution {
                        user_id: None,
                        attempt: 0,
                        status: NodeStatus::Pending,
                        started_at: None,
                        finished_at: None,
                        duration_ms: None,
                        exit_code: None,
                        stdout_path: None,
                        stderr_path: None,
                        stdout_preview: String::new(),
                        stderr_preview: String::new(),
                        stdout: None,
                        stderr: None,
                        result: None,
                    },
                },
            );
        }

        let state = RunState {
            run_id: RunId::try_from("019cc300-0000-7000-8000-000000000001")?,
            workflow_id: WorkflowId::try_from("plan")?,
            status: RunStatus::Succeeded,
            reason: None,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
            finished_at: None,
            workflow_conversations: BTreeMap::new(),
            nodes,
            node_frames: BTreeMap::new(),
        };

        let snapshot = RunSnapshot::from(&state);
        assert_eq!(
            snapshot.nodes.into_iter().map(|node| node.node_path).collect::<Vec<_>>(),
            vec!["/1/2", "/1/10", "/2", "/10"]
        );
        Ok(())
    }

    #[test]
    fn snapshots_exclude_per_frame_history() -> Result<(), Box<dyn std::error::Error>> {
        let loop_scope = FrameId::root().child_loop_scope(&NodePath::try_from("/0")?);
        let frame_id = FrameId::for_loop_iteration(&loop_scope, 1);
        let state = RunState {
            run_id: RunId::try_from("019cc300-0000-7000-8000-000000000001")?,
            workflow_id: WorkflowId::try_from("plan")?,
            status: RunStatus::Succeeded,
            reason: None,
            started_at: "2026-01-01T00:00:00Z".to_owned(),
            finished_at: None,
            workflow_conversations: BTreeMap::new(),
            nodes: BTreeMap::new(),
            node_frames: BTreeMap::from([(
                (frame_id.clone(), NodePath::try_from("/0")?),
                NodeFrameResult {
                    frame_id,
                    node_path: NodePath::try_from("/0")?,
                    execution: Execution {
                        user_id: None,
                        attempt: 1,
                        status: NodeStatus::Succeeded,
                        started_at: Some("2026-01-01T00:00:00Z".to_owned()),
                        finished_at: Some("2026-01-01T00:00:01Z".to_owned()),
                        duration_ms: Some(1),
                        exit_code: Some(0),
                        stdout_path: None,
                        stderr_path: None,
                        stdout_preview: String::new(),
                        stderr_preview: String::new(),
                        stdout: None,
                        stderr: None,
                        result: None,
                    },
                },
            )]),
        };

        let json = serde_json::to_value(RunSnapshot::from(&state))?;
        assert!(json.get("node_frames").is_none());
        Ok(())
    }

    #[test]
    fn projects_branch_selected_events() -> Result<(), Box<dyn std::error::Error>> {
        let event = Event::from(&RunEvent::BranchSelected {
            frame_id: FrameId::root(),
            node_path: NodePath::try_from("/0")?,
            user_id: Some("decide".parse()?),
            case_index: 1,
            selection: rigg_core::BranchSelection::Else,
        });

        assert_eq!(
            serde_json::to_value(event)?,
            serde_json::json!({
                "kind": "branch_selected",
                "frame_id": "root",
                "node_path": "/0",
                "user_id": "decide",
                "case_index": 1,
                "selection": "else"
            })
        );
        Ok(())
    }

    #[test]
    fn projects_timeout_run_reasons() -> Result<(), Box<dyn std::error::Error>> {
        let timed_out = serde_json::to_value(Event::from(&RunEvent::RunFailed {
            reason: rigg_core::RunReason::StepTimedOut,
            message: "timeout".to_owned(),
        }))?;

        assert_eq!(timed_out["reason"], "step_timed_out");
        Ok(())
    }
}
