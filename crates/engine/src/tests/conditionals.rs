use super::fixture::{
    FixedClock, RecordingExecutor, TraceRecorder, action_node, plan_with_nodes, shell_node,
    structured_schema, successful_text_step, text_shell_node,
};
use crate::{
    ActionKind, ClaudeStep, Engine, NodeStatus, PermissionMode, ResultContract, RunEvent,
    RunStatus, ShellOutput, StepRunRequest, Template,
};

#[test]
fn skips_false_condition() -> Result<(), Box<dyn std::error::Error>> {
    let executor = super::fixture::FakeExecutor::new(Vec::new());
    let mut recorder = TraceRecorder::default();
    let node = shell_node(
        0,
        "skip_me",
        "echo hidden",
        ShellOutput::Text,
        ResultContract::Text,
        Some("${{ false }}"),
    )?;
    let plan = plan_with_nodes(vec![node.clone()])?;

    let state = Engine.run_plan(plan, &executor, &mut recorder, &FixedClock)?;

    let Some(node_state) = state.nodes.get(&node.path) else {
        panic!("missing node state for {}", node.path);
    };
    assert_eq!(node_state.execution.status, NodeStatus::Skipped);
    assert_eq!(state.status, RunStatus::Succeeded);
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeSkipped { node_path, .. } if node_path == &node.path
    )));
    Ok(())
}

#[test]
fn excludes_skipped_step_from_context() -> Result<(), Box<dyn std::error::Error>> {
    let maybe = action_node(
        0,
        Some("maybe"),
        ActionKind::Claude(ClaudeStep {
            prompt: Template::parse("hello")?,
            model: None,
            permission_mode: PermissionMode::Default,
            add_dirs: vec![],
            persistence: crate::Persistence::Persist,
            conversation: None,
        }),
        ResultContract::Json {
            schema: Some(structured_schema(serde_json::json!({
                "type":"object",
                "required":["accepted_count"],
                "properties":{
                    "accepted_count":{"type":"integer"}
                }
            }))?),
        },
        Some("${{ false }}"),
    )?;
    let inspect = text_shell_node(1, "inspect", "echo ${{ toJSON(steps) }}")?;
    let executor = RecordingExecutor::new(vec![successful_text_step("ok")]);

    let state = Engine.run_plan(
        plan_with_nodes(vec![maybe.clone(), inspect])?,
        &executor,
        &mut TraceRecorder::default(),
        &FixedClock,
    )?;

    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 1);
    match &requests[0] {
        StepRunRequest::Shell(request) => assert_eq!(request.command, "echo {}"),
        other => panic!("unexpected request: {other:?}"),
    }
    let Some(maybe_state) = state.nodes.get(&maybe.path) else {
        panic!("missing node state for {}", maybe.path);
    };
    assert_eq!(maybe_state.execution.status, NodeStatus::Skipped);
    Ok(())
}
