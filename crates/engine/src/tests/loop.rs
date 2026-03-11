use super::fixture::{
    AdvancingClock, FakeExecutor, FixedClock, MemoryRecorder, RecordingExecutor, TraceRecorder,
    action_node_at_path, loop_node, loop_node_at_path, plan_with_nodes, structured_schema,
    successful_json_step, successful_text_step, text_shell_node_at_path,
};
use crate::{
    ActionKind, ClaudeStep, Engine, EngineError, EvaluationError, LoopIterationOutcome, NodePath,
    NodeStatus, PermissionMode, ResultContract, ResultError, RunEvent, RunStatus, StepRunRequest,
    Template,
};

#[test]
fn nested_loops_use_frame_metadata() -> Result<(), Box<dyn std::error::Error>> {
    let inner_loop_path = NodePath::root_child(0).child(0);
    let inner_leaf = text_shell_node_at_path(
        2,
        "inner_leaf",
        inner_loop_path.child(0),
        "echo inner:${{ run.node_path }}:${{ run.iteration }}/${{ run.max_iterations }}",
    )?;
    let inner_loop =
        loop_node_at_path(1, "inner", inner_loop_path, vec![inner_leaf], "true", 1, vec![])?;
    let outer_leaf = text_shell_node_at_path(
        3,
        "outer_leaf",
        NodePath::root_child(0).child(1),
        "echo outer:${{ run.node_path }}:${{ run.iteration }}/${{ run.max_iterations }}",
    )?;
    let outer_loop = loop_node(0, "outer", vec![inner_loop, outer_leaf], "true", 1, vec![])?;
    let plan = plan_with_nodes(vec![outer_loop])?;
    let executor =
        RecordingExecutor::new(vec![successful_text_step("inner"), successful_text_step("outer")]);
    let mut recorder = MemoryRecorder;

    Engine.run_plan(plan, &executor, &mut recorder, &FixedClock)?;

    let requests = super::fixture::lock(&executor.requests);
    match &requests[0] {
        StepRunRequest::Shell(request) => {
            assert_eq!(request.command, "echo inner:/0/0:1/1");
        }
        other => panic!("unexpected request: {other:?}"),
    }
    match &requests[1] {
        StepRunRequest::Shell(request) => {
            assert_eq!(request.command, "echo outer:/0:1/1");
        }
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}

#[test]
fn records_iteration_events() -> Result<(), Box<dyn std::error::Error>> {
    let loop_path = NodePath::root_child(0);
    let judge = text_shell_node_at_path(1, "judge", loop_path.child(0), "echo judge")?;
    let remediation =
        loop_node(0, "remediation", vec![judge], "steps.judge.result == 'done'", 2, vec![])?;
    let plan = plan_with_nodes(vec![remediation.clone()])?;
    let executor =
        FakeExecutor::new(vec![successful_text_step("retry"), successful_text_step("done")]);
    let mut recorder = TraceRecorder::default();

    Engine.run_plan(plan, &executor, &mut recorder, &FixedClock)?;

    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::LoopIterationStarted { node_path, iteration: 1, max_iterations: 2, .. }
            if node_path == &remediation.path
    )));
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::LoopIterationFinished {
            node_path,
            iteration: 1,
            max_iterations: 2,
            outcome: LoopIterationOutcome::Continue,
            ..
        } if node_path == &remediation.path
    )));
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::LoopIterationFinished {
            node_path,
            iteration: 2,
            max_iterations: 2,
            outcome: LoopIterationOutcome::Completed,
            ..
        } if node_path == &remediation.path
    )));
    Ok(())
}

#[test]
fn runs_until_satisfied_and_exports() -> Result<(), Box<dyn std::error::Error>> {
    let judge_schema = structured_schema(serde_json::json!({
        "type":"object",
        "required":["accepted_count"],
        "properties":{
            "accepted_count":{"type":"integer"}
        }
    }))?;
    let loop_path = NodePath::root_child(0);
    let judge = action_node_at_path(
        1,
        Some("judge"),
        loop_path.child(0),
        ActionKind::Claude(ClaudeStep {
            prompt: Template::parse("Judge")?,
            model: None,
            permission_mode: PermissionMode::Default,
            add_dirs: vec![],
            persistence: crate::Persistence::Persist,
            conversation: None,
        }),
        ResultContract::Json { schema: Some(judge_schema) },
        None,
    )?;
    let remediation = loop_node(
        0,
        "remediation",
        vec![judge.clone()],
        "steps.judge.result.accepted_count == 0",
        5,
        vec![("accepted_count", "steps.judge.result.accepted_count", crate::ResultShape::Integer)],
    )?;
    let plan = plan_with_nodes(vec![remediation.clone()])?;
    let executor = FakeExecutor::new(vec![
        successful_json_step(serde_json::json!({"accepted_count": 1})),
        successful_json_step(serde_json::json!({"accepted_count": 0})),
    ]);
    let mut recorder = TraceRecorder::default();
    let clock = AdvancingClock::new("2026-01-01T00:00:00Z");

    let state = Engine.run_plan(plan, &executor, &mut recorder, &clock)?;

    let Some(loop_state) = state.nodes.get(&remediation.path) else {
        panic!("missing node state for {}", remediation.path);
    };
    assert_eq!(loop_state.execution.status, NodeStatus::Succeeded);
    assert_eq!(loop_state.execution.duration_ms, Some(9000));
    assert_eq!(
        loop_state.execution.result,
        Some(crate::CapturedValue::Json(serde_json::json!({"accepted_count": 0})))
    );
    let Some(judge_state) = state.nodes.get(&judge.path) else {
        panic!("missing node state for {}", judge.path);
    };
    assert_eq!(judge_state.execution.attempt, 2);
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeFinished(event)
            if event.node_path == remediation.path && event.status == NodeStatus::Succeeded
    )));
    Ok(())
}

#[test]
fn records_failure_on_until_error() -> Result<(), Box<dyn std::error::Error>> {
    let loop_path = NodePath::root_child(0);
    let produce = text_shell_node_at_path(1, "produce", loop_path.child(0), "printf done")?;
    let remediation = loop_node(
        0,
        "remediation",
        vec![produce],
        "join(steps.produce.result, \",\") == \"done\"",
        3,
        vec![],
    )?;
    let plan = plan_with_nodes(vec![remediation.clone()])?;
    let executor = FakeExecutor::new(vec![successful_text_step("done")]);
    let mut recorder = TraceRecorder::default();

    let error = Engine
        .run_plan(plan, &executor, &mut recorder, &FixedClock)
        .expect_err("loop until evaluation should fail");
    assert!(matches!(error, EngineError::Evaluation(EvaluationError::Expr { .. })));

    let started = recorder
        .events
        .iter()
        .filter(|record| {
            matches!(
                &record.event,
                RunEvent::LoopIterationStarted { node_path, iteration: 1, .. }
                    if node_path == &remediation.path
            )
        })
        .count();
    assert_eq!(started, 1);
    let failed = recorder
        .events
        .iter()
        .filter(|record| {
            matches!(
                &record.event,
                RunEvent::LoopIterationFinished {
                    node_path,
                    iteration: 1,
                    outcome: LoopIterationOutcome::Failed,
                    ..
                } if node_path == &remediation.path
            )
        })
        .count();
    assert_eq!(failed, 1);
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeFinished(event)
            if event.node_path == remediation.path && event.status == NodeStatus::Failed
    )));
    Ok(())
}

#[test]
fn records_failure_on_export_error() -> Result<(), Box<dyn std::error::Error>> {
    let loop_path = NodePath::root_child(0);
    let produce = text_shell_node_at_path(1, "produce", loop_path.child(0), "printf done")?;
    let remediation = loop_node(
        0,
        "remediation",
        vec![produce],
        "true",
        3,
        vec![("joined", "join(steps.produce.result, \",\")", crate::ResultShape::String)],
    )?;
    let plan = plan_with_nodes(vec![remediation.clone()])?;
    let executor = FakeExecutor::new(vec![successful_text_step("done")]);
    let mut recorder = TraceRecorder::default();

    let error = Engine
        .run_plan(plan, &executor, &mut recorder, &FixedClock)
        .expect_err("loop export evaluation should fail");
    assert!(matches!(error, EngineError::Evaluation(EvaluationError::Expr { .. })));
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::LoopIterationFinished {
            node_path,
            iteration: 1,
            outcome: LoopIterationOutcome::Failed,
            ..
        } if node_path == &remediation.path
    )));
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeFinished(event)
            if event.node_path == remediation.path && event.status == NodeStatus::Failed
    )));
    Ok(())
}

#[test]
fn records_failure_before_propagating() -> Result<(), Box<dyn std::error::Error>> {
    let judge_schema = structured_schema(serde_json::json!({
        "type":"object",
        "required":["accepted_count"],
        "properties":{
            "accepted_count":{"type":"integer"}
        }
    }))?;
    let loop_path = NodePath::root_child(0);
    let judge = action_node_at_path(
        1,
        Some("judge"),
        loop_path.child(0),
        ActionKind::Claude(ClaudeStep {
            prompt: Template::parse("Judge")?,
            model: None,
            permission_mode: PermissionMode::Default,
            add_dirs: vec![],
            persistence: crate::Persistence::Persist,
            conversation: None,
        }),
        ResultContract::Json { schema: Some(judge_schema) },
        None,
    )?;
    let remediation = loop_node(
        0,
        "remediation",
        vec![judge],
        "steps.judge.result.accepted_count == 0",
        5,
        vec![("accepted_count", "steps.judge.result.accepted_count", crate::ResultShape::Integer)],
    )?;
    let plan = plan_with_nodes(vec![remediation.clone()])?;
    let executor = FakeExecutor::new(vec![successful_json_step(
        serde_json::json!({"accepted_count": "nope"}),
    )]);
    let mut recorder = TraceRecorder::default();

    let error = Engine
        .run_plan(plan, &executor, &mut recorder, &FixedClock)
        .expect_err("loop body schema mismatch should fail");
    assert!(matches!(
        error,
        EngineError::Result(ResultError::ResultTypeMismatch { ref node, ref output, .. })
            if node == "judge" && output == "accepted_count"
    ));

    let Some(state) = recorder.states.last() else {
        panic!("expected recorded state");
    };
    let Some(loop_state) = state.nodes.get(&remediation.path) else {
        panic!("missing node state for {}", remediation.path);
    };
    assert_eq!(state.status, RunStatus::Failed);
    assert_eq!(loop_state.execution.status, NodeStatus::Failed);
    assert!(loop_state.execution.finished_at.is_some());
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeFinished(event)
            if event.node_path == remediation.path && event.status == NodeStatus::Failed
    )));
    Ok(())
}
