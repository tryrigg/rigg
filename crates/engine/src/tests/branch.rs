use super::fixture::{
    FakeExecutor, FixedClock, RecordingExecutor, TraceRecorder, branch_else, branch_if,
    branch_node, failed_step, plan_with_nodes, successful_text_step, text_shell_node,
};
use crate::{
    BranchSelection, CapturedValue, Engine, NodePath, NodeStatus, ResultShape, RunEvent, RunStatus,
    StepRunRequest,
};

#[test]
fn runs_first_matching_case() -> Result<(), Box<dyn std::error::Error>> {
    let first_case = vec![text_shell_node(10, "first_case", "printf first")?];
    let second_case = vec![text_shell_node(11, "second_case", "printf second")?];
    let decide = branch_node(
        0,
        "decide",
        vec![
            branch_if(
                "false",
                first_case,
                vec![("summary", "steps.first_case.result", ResultShape::String)],
            ),
            branch_if(
                "true",
                second_case,
                vec![("summary", "steps.second_case.result", ResultShape::String)],
            ),
            branch_else(
                vec![text_shell_node(12, "fallback_case", "printf fallback")?],
                vec![("summary", "steps.fallback_case.result", ResultShape::String)],
            ),
        ],
    )?;
    let consume = text_shell_node(1, "consume", "echo ${{ steps.decide.result.summary }}")?;
    let plan = plan_with_nodes(vec![decide.clone(), consume])?;
    let executor =
        RecordingExecutor::new(vec![successful_text_step("second"), successful_text_step("done")]);
    let mut recorder = TraceRecorder::default();

    let state = Engine.run_plan(plan, &executor, &mut recorder, &FixedClock)?;

    let Some(branch_state) = state.nodes.get(&decide.path) else {
        panic!("missing branch node state");
    };
    assert_eq!(branch_state.execution.status, NodeStatus::Succeeded);
    assert_eq!(
        branch_state.execution.result,
        Some(CapturedValue::Json(serde_json::json!({ "summary": "second" })))
    );
    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 2);
    match &requests[0] {
        StepRunRequest::Shell(request) => assert_eq!(request.command, "printf second"),
        other => panic!("unexpected request: {other:?}"),
    }
    match &requests[1] {
        StepRunRequest::Shell(request) => assert_eq!(request.command, "echo second"),
        other => panic!("unexpected request: {other:?}"),
    }
    assert_eq!(
        recorder
            .events
            .iter()
            .filter(|record| matches!(record.event, RunEvent::BranchSelected { .. }))
            .count(),
        1
    );
    Ok(())
}

#[test]
fn marks_non_selected_nodes_skipped() -> Result<(), Box<dyn std::error::Error>> {
    let first_case = text_shell_node(10, "first_case", "printf first")?;
    let second_case = text_shell_node(11, "second_case", "printf second")?;
    let fallback_case = text_shell_node(12, "fallback_case", "printf fallback")?;
    let decide = branch_node(
        0,
        "decide",
        vec![
            branch_if(
                "false",
                vec![first_case],
                vec![("summary", "steps.first_case.result", ResultShape::String)],
            ),
            branch_if(
                "true",
                vec![second_case],
                vec![("summary", "steps.second_case.result", ResultShape::String)],
            ),
            branch_else(
                vec![fallback_case],
                vec![("summary", "steps.fallback_case.result", ResultShape::String)],
            ),
        ],
    )?;
    let executor = RecordingExecutor::new(vec![successful_text_step("second")]);

    let state = Engine.run_plan(
        plan_with_nodes(vec![decide])?,
        &executor,
        &mut TraceRecorder::default(),
        &FixedClock,
    )?;

    let Some(first_state) = state.nodes.get(&NodePath::root_child(0).child(0).child(0)) else {
        panic!("missing state for first branch node");
    };
    assert_eq!(first_state.execution.status, NodeStatus::Skipped);
    let Some(second_state) = state.nodes.get(&NodePath::root_child(0).child(1).child(0)) else {
        panic!("missing state for selected branch node");
    };
    assert_eq!(second_state.execution.status, NodeStatus::Succeeded);
    let Some(fallback_state) = state.nodes.get(&NodePath::root_child(0).child(2).child(0)) else {
        panic!("missing state for fallback branch node");
    };
    assert_eq!(fallback_state.execution.status, NodeStatus::Skipped);
    Ok(())
}

#[test]
fn uses_else_when_no_case_matches() -> Result<(), Box<dyn std::error::Error>> {
    let decide = branch_node(
        0,
        "decide",
        vec![
            branch_if(
                "false",
                vec![text_shell_node(10, "never", "printf never")?],
                vec![("summary", "steps.never.result", ResultShape::String)],
            ),
            branch_else(
                vec![text_shell_node(11, "fallback", "printf fallback")?],
                vec![("summary", "steps.fallback.result", ResultShape::String)],
            ),
        ],
    )?;
    let executor = RecordingExecutor::new(vec![successful_text_step("fallback")]);
    let mut recorder = TraceRecorder::default();

    let _ =
        Engine.run_plan(plan_with_nodes(vec![decide])?, &executor, &mut recorder, &FixedClock)?;

    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::BranchSelected { case_index: 1, selection: BranchSelection::Else, .. }
    )));
    Ok(())
}

#[test]
fn marks_all_nodes_skipped_when_unmatched() -> Result<(), Box<dyn std::error::Error>> {
    let never = text_shell_node(10, "never", "printf never")?;
    let state = Engine.run_plan(
        plan_with_nodes(vec![branch_node(
            0,
            "decide",
            vec![branch_if("false", vec![never], vec![])],
        )?])?,
        &FakeExecutor::new(vec![]),
        &mut TraceRecorder::default(),
        &FixedClock,
    )?;

    let Some(never_state) = state.nodes.get(&NodePath::root_child(0).child(0).child(0)) else {
        panic!("missing state for non-matching branch node");
    };
    assert_eq!(never_state.execution.status, NodeStatus::Skipped);
    Ok(())
}

#[test]
fn skips_when_no_case_and_no_else() -> Result<(), Box<dyn std::error::Error>> {
    let decide = branch_node(
        0,
        "decide",
        vec![branch_if("false", vec![text_shell_node(10, "never", "printf never")?], vec![])],
    )?;
    let mut recorder = TraceRecorder::default();

    let state = Engine.run_plan(
        plan_with_nodes(vec![decide.clone()])?,
        &FakeExecutor::new(vec![]),
        &mut recorder,
        &FixedClock,
    )?;

    let Some(branch_state) = state.nodes.get(&decide.path) else {
        panic!("missing branch node state");
    };
    assert_eq!(branch_state.execution.status, NodeStatus::Skipped);
    assert_eq!(state.status, RunStatus::Succeeded);
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeSkipped { node_path, reason, .. }
            if node_path == &decide.path && reason == "no branch case matched"
    )));
    assert!(
        !recorder
            .events
            .iter()
            .any(|record| matches!(record.event, RunEvent::BranchSelected { .. }))
    );
    Ok(())
}

#[test]
fn fails_when_selected_case_fails() -> Result<(), Box<dyn std::error::Error>> {
    let decide = branch_node(
        0,
        "decide",
        vec![branch_if(
            "true",
            vec![text_shell_node(10, "boom", "printf boom")?],
            vec![("summary", "steps.boom.result", ResultShape::String)],
        )],
    )?;
    let executor = FakeExecutor::new(vec![failed_step("boom")]);
    let mut recorder = TraceRecorder::default();

    let state = Engine.run_plan(
        plan_with_nodes(vec![decide.clone()])?,
        &executor,
        &mut recorder,
        &FixedClock,
    )?;

    let Some(branch_state) = state.nodes.get(&decide.path) else {
        panic!("missing branch node state");
    };
    assert_eq!(state.status, RunStatus::Failed);
    assert_eq!(branch_state.execution.status, NodeStatus::Failed);
    Ok(())
}
