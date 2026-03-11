use super::fixture::{
    BlockingGate, ConcurrentGateExecutor, CustomLogPathRecorder, FakeExecutor, FixedClock,
    LiveProgressParallelExecutor, MappedExecutor, MemoryRecorder, MidBranchCheckpointExecutor,
    ProgressModeExecutor, SharedStateRecorder, SharedTraceProgress, SnapshottingParallelExecutor,
    TraceProgress, TraceRecorder, action_node_at_path, failed_step, lock, parallel_node,
    plan_with_nodes, structured_schema, successful_json_step, successful_text_step,
    text_shell_node, text_shell_node_at_path,
};
use crate::{
    ActionKind, ClaudeStep, Engine, EngineError, FrameId, LiveEvent, NodePath, NodeStatus,
    PermissionMode, ResultContract, ResultError, RunEvent, RunRecorder, RunStatus, StepRunRequest,
    StreamKind, Template,
};
use std::sync::Arc;

#[test]
fn runs_all_branches_and_exports() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![
            vec![text_shell_node(10, "lint_result", "printf lint")?],
            vec![text_shell_node(11, "test_result", "printf test")?],
        ],
        vec![(
            "summary",
            "format('{0}:{1}', steps.lint_result.result, steps.test_result.result)",
            crate::ResultShape::String,
        )],
    )?;
    let consume = text_shell_node(1, "consume", "echo ${{ steps.fanout.result.summary }}")?;
    let executor = MappedExecutor::new(vec![
        ("shell:printf lint", successful_text_step("lint")),
        ("shell:printf test", successful_text_step("test")),
        ("shell:echo lint:test", successful_text_step("done")),
    ]);
    let state = Engine.run_plan(
        plan_with_nodes(vec![fanout.clone(), consume])?,
        &executor,
        &mut TraceRecorder::default(),
        &FixedClock,
    )?;

    let Some(fanout_state) = state.nodes.get(&fanout.path) else {
        panic!("missing parallel node state");
    };
    assert_eq!(fanout_state.execution.status, NodeStatus::Succeeded);
    assert_eq!(
        fanout_state.execution.result,
        Some(crate::CapturedValue::Json(serde_json::json!({ "summary": "lint:test" })))
    );
    let requests = lock(&executor.requests);
    assert_eq!(requests.len(), 3);
    let mut commands = requests
        .iter()
        .map(|request| match request {
            StepRunRequest::Shell(request) => request.command.clone(),
            other => panic!("unexpected request: {other:?}"),
        })
        .collect::<Vec<_>>();
    let Some(downstream) = commands.pop() else {
        panic!("expected downstream command");
    };
    commands.sort();
    assert_eq!(commands, vec!["printf lint", "printf test"]);
    assert_eq!(downstream, "echo lint:test");
    Ok(())
}

#[test]
fn executes_branches_concurrently() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![
            vec![text_shell_node(10, "lint_result", "printf lint")?],
            vec![text_shell_node(11, "test_result", "printf test")?],
        ],
        vec![],
    )?;
    let mut recorder = MemoryRecorder;

    Engine.run_plan(
        plan_with_nodes(vec![fanout])?,
        &ConcurrentGateExecutor::default(),
        &mut recorder,
        &FixedClock,
    )?;

    Ok(())
}

#[test]
fn forwards_progress_before_join() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![
            vec![text_shell_node(10, "fast_result", "printf fast")?],
            vec![text_shell_node(11, "slow_result", "printf slow")?],
        ],
        vec![],
    )?;
    let gate = Arc::new(BlockingGate::default());
    let executor = LiveProgressParallelExecutor { gate: gate.clone() };
    let (mut progress, shared_progress) = SharedTraceProgress::new();
    let plan = plan_with_nodes(vec![fanout])?;
    let handle = std::thread::spawn(move || {
        let mut recorder = MemoryRecorder;
        Engine
            .run_plan_with_progress(plan, &executor, &mut recorder, &FixedClock, &mut progress)
            .map_err(|error| error.to_string())
    });

    let (events, ready) = &*shared_progress;
    let (guard, timeout) = ready
        .wait_timeout_while(lock(events), std::time::Duration::from_millis(300), |events| {
            !events.iter().any(|event| {
                matches!(event, LiveEvent::ProviderStatus { message, .. } if message == "fast-live")
            })
        })
        .expect("condvar wait should not be poisoned");
    assert!(
        !timeout.timed_out(),
        "parallel branch progress should be visible before sibling branches join"
    );
    drop(guard);

    gate.release();
    let state =
        handle.join().expect("engine thread should not panic").map_err(std::io::Error::other)?;
    assert_eq!(state.status, RunStatus::Succeeded);
    Ok(())
}

#[test]
fn writes_merged_state_per_branch() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![
            vec![text_shell_node(10, "fast_result", "printf fast")?],
            vec![text_shell_node(11, "slow_result", "printf slow")?],
        ],
        vec![],
    )?;
    let mut recorder = TraceRecorder::default();

    Engine.run_plan(
        plan_with_nodes(vec![fanout.clone()])?,
        &SnapshottingParallelExecutor,
        &mut recorder,
        &FixedClock,
    )?;

    assert!(recorder.states.iter().any(|state| {
        matches!(
            (
                state.nodes.get(&fanout.path.child(0).child(0)),
                state.nodes.get(&fanout.path.child(1).child(0)),
            ),
            (
                Some(fast),
                Some(slow),
            ) if fast.execution.status == NodeStatus::Succeeded
                && slow.execution.status == NodeStatus::Pending
        )
    }));
    Ok(())
}

#[test]
fn persists_checkpoints_mid_branch() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![vec![
            text_shell_node(10, "first_result", "printf first")?,
            text_shell_node(11, "second_result", "printf second")?,
        ]],
        vec![],
    )?;
    let first_path = fanout.path.child(0).child(0);
    let second_path = fanout.path.child(0).child(1);
    let gate = Arc::new(BlockingGate::default());
    let executor = MidBranchCheckpointExecutor { gate: gate.clone() };
    let (mut recorder, shared_states) = SharedStateRecorder::new();
    let plan = plan_with_nodes(vec![fanout])?;
    let handle = std::thread::spawn(move || {
        Engine
            .run_plan(plan, &executor, &mut recorder, &FixedClock)
            .map_err(|error| error.to_string())
    });

    let (states, ready) = &*shared_states;
    let (guard, timeout) = ready
        .wait_timeout_while(lock(states), std::time::Duration::from_millis(300), |states| {
            !states.iter().any(|state| {
                matches!(
                    (
                        state.nodes.get(&first_path),
                        state.nodes.get(&second_path),
                    ),
                    (Some(first), Some(second))
                        if first.execution.status == NodeStatus::Succeeded
                            && second.execution.status == NodeStatus::Pending
                )
            })
        })
        .expect("condvar wait should not be poisoned");
    assert!(
        !timeout.timed_out(),
        "parallel branch checkpoints should be written before the branch finishes"
    );
    drop(guard);

    gate.release();
    let state =
        handle.join().expect("engine thread should not panic").map_err(std::io::Error::other)?;
    assert_eq!(state.status, RunStatus::Succeeded);
    Ok(())
}

#[test]
fn fails_after_running_all_branches() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![
            vec![text_shell_node(10, "lint_result", "printf lint")?],
            vec![text_shell_node(11, "test_result", "printf test")?],
        ],
        vec![],
    )?;
    let executor = MappedExecutor::new(vec![
        ("shell:printf lint", failed_step("lint failed")),
        ("shell:printf test", successful_text_step("test")),
    ]);

    let state = Engine.run_plan(
        plan_with_nodes(vec![fanout.clone()])?,
        &executor,
        &mut TraceRecorder::default(),
        &FixedClock,
    )?;

    assert_eq!(state.status, RunStatus::Failed);
    let Some(fanout_state) = state.nodes.get(&fanout.path) else {
        panic!("missing parallel node state");
    };
    assert_eq!(fanout_state.execution.status, NodeStatus::Failed);
    let Some(lint_state) = state.nodes.get(&fanout.path.child(0).child(0)) else {
        panic!("missing lint branch node state");
    };
    assert_eq!(lint_state.execution.status, NodeStatus::Failed);
    let Some(test_state) = state.nodes.get(&fanout.path.child(1).child(0)) else {
        panic!("missing test branch node state");
    };
    assert_eq!(test_state.execution.status, NodeStatus::Succeeded);
    assert_eq!(lock(&executor.requests).len(), 2);
    Ok(())
}

#[test]
fn propagates_branch_errors_after_join() -> Result<(), Box<dyn std::error::Error>> {
    let judge_schema = structured_schema(serde_json::json!({
        "type":"object",
        "required":["accepted_count"],
        "properties":{
            "accepted_count":{"type":"integer"}
        }
    }))?;
    let fanout = parallel_node(
        0,
        "fanout",
        vec![
            vec![action_node_at_path(
                10,
                Some("judge"),
                NodePath::try_from("/0/0/0")?,
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
            )?],
            vec![text_shell_node_at_path(
                11,
                "test_result",
                NodePath::try_from("/0/1/0")?,
                "printf test",
            )?],
        ],
        vec![],
    )?;
    let executor = MappedExecutor::new(vec![
        ("claude:Judge", successful_json_step(serde_json::json!({"accepted_count": "nope"}))),
        ("shell:printf test", successful_text_step("test")),
    ]);
    let mut recorder = TraceRecorder::default();

    let error = Engine
        .run_plan(plan_with_nodes(vec![fanout.clone()])?, &executor, &mut recorder, &FixedClock)
        .expect_err("parallel should propagate the branch error");

    assert!(matches!(
        error,
        EngineError::Result(ResultError::ResultTypeMismatch { ref node, ref output, .. })
            if node == "judge" && output == "accepted_count"
    ));
    assert_eq!(lock(&executor.requests).len(), 2);

    let Some(state) = recorder.states.last() else {
        panic!("expected recorded state");
    };
    assert_eq!(state.status, RunStatus::Failed);
    let Some(fanout_state) = state.nodes.get(&fanout.path) else {
        panic!("missing parallel node state");
    };
    assert_eq!(fanout_state.execution.status, NodeStatus::Failed);
    let Some(test_state) = state.nodes.get(&fanout.path.child(1).child(0)) else {
        panic!("missing successful branch node state");
    };
    assert_eq!(test_state.execution.status, NodeStatus::Succeeded);
    Ok(())
}

#[test]
fn preserves_progress_mode_in_branches() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![
            vec![text_shell_node(10, "lint_result", "printf lint")?],
            vec![text_shell_node(11, "test_result", "printf test")?],
        ],
        vec![],
    )?;

    let executor = ProgressModeExecutor::default();
    let mut recorder = MemoryRecorder;
    Engine.run_plan(
        plan_with_nodes(vec![fanout.clone()])?,
        &executor,
        &mut recorder,
        &FixedClock,
    )?;
    assert_eq!(lock(&executor.seen_progress_modes).as_slice(), &[false, false]);

    let executor = ProgressModeExecutor::default();
    let mut progress = TraceProgress::default();
    let mut recorder = MemoryRecorder;
    Engine.run_plan_with_progress(
        plan_with_nodes(vec![fanout])?,
        &executor,
        &mut recorder,
        &FixedClock,
        &mut progress,
    )?;
    assert_eq!(lock(&executor.seen_progress_modes).as_slice(), &[true, true]);
    Ok(())
}

#[test]
fn uses_recorder_log_paths_for_branches() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![vec![text_shell_node(10, "branch_result", "printf branch")?]],
        vec![],
    )?;
    let executor = FakeExecutor::new(vec![crate::StepRunResult {
        started_at: "2026-01-01T00:00:00Z".to_owned(),
        finished_at: "2026-01-01T00:00:01Z".to_owned(),
        duration_ms: 1,
        exit_code: 0,
        stdout: "branch stdout".to_owned(),
        stderr: "branch stderr".to_owned(),
        result: Some(crate::CapturedValue::Text("branch stdout".to_owned())),
        conversation_handle: None,
        provider_events: Vec::new(),
    }]);
    let mut progress = TraceProgress::default();
    let mut recorder = CustomLogPathRecorder::default();

    let state = Engine.run_plan_with_progress(
        plan_with_nodes(vec![fanout.clone()])?,
        &executor,
        &mut recorder,
        &FixedClock,
        &mut progress,
    )?;

    let branch_action_path = fanout.path.child(0).child(0);
    let branch_frame = FrameId::for_parallel_branch(&FrameId::root(), &fanout.path, 0);
    let expected_stdout =
        recorder.log_path(&branch_frame, &branch_action_path, 1, StreamKind::Stdout);
    let expected_stderr =
        recorder.log_path(&branch_frame, &branch_action_path, 1, StreamKind::Stderr);
    let Some(execution) = state.nodes.get(&branch_action_path).map(|node| &node.execution) else {
        panic!("branch action state should be present");
    };
    let Some(event) = recorder.events.iter().find_map(|record| match &record.event {
        RunEvent::NodeFinished(event) if event.node_path == branch_action_path => Some(event),
        _ => None,
    }) else {
        panic!("branch action finished event should be present");
    };
    let Some(progress_event) = progress.events.iter().find_map(|event| match event {
        LiveEvent::NodeFinished { node_path, stdout_path, stderr_path, .. }
            if *node_path == branch_action_path =>
        {
            Some((stdout_path.as_deref(), stderr_path.as_deref()))
        }
        _ => None,
    }) else {
        panic!("branch action progress event should be present");
    };

    assert_eq!(execution.stdout_path.as_deref(), Some(expected_stdout.as_str()));
    assert_eq!(execution.stderr_path.as_deref(), Some(expected_stderr.as_str()));
    assert_eq!(event.stdout_path.as_deref(), Some(expected_stdout.as_str()));
    assert_eq!(event.stderr_path.as_deref(), Some(expected_stderr.as_str()));
    assert_eq!(progress_event.0, Some(expected_stdout.as_str()));
    assert_eq!(progress_event.1, Some(expected_stderr.as_str()));
    assert_eq!(
        recorder.logs.as_slice(),
        &[
            (expected_stdout, "branch stdout".to_owned()),
            (expected_stderr, "branch stderr".to_owned()),
        ]
    );
    Ok(())
}
