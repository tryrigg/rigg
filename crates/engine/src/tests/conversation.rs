use super::fixture::{
    FixedClock, MappedExecutor, MemoryRecorder, RecordingExecutor, TraceRecorder,
    action_node_at_path, assert_resume_thread, codex_exec_node, conversation, empty_run_state,
    handle_result, loop_node, loop_node_at_path, parallel_node, parallel_node_at_path,
    plan_with_nodes, workflow_conversation,
};
use crate::context::FrameContext;
use crate::conversations::ConversationState;
use crate::{
    ActionKind, CodexAction, CodexExec, CodexMode, CodexStep, ConversationBinding,
    ConversationHandle, ConversationScope, Engine, EngineError, ExecutorError, NodePath,
    ResultContract, RunStatus, StepRunRequest, Template,
};
#[test]
fn reuses_handles_between_nodes() -> Result<(), Box<dyn std::error::Error>> {
    let first = codex_exec_node(0, "first", "First", Some("thread"))?;
    let second = codex_exec_node(1, "second", "Second", Some("thread"))?;
    let plan = plan_with_nodes(vec![first, second])?;
    let executor = RecordingExecutor::new(vec![
        handle_result("first", "thread-123"),
        handle_result("second", "thread-123"),
    ]);
    let mut recorder = MemoryRecorder;

    Engine.run_plan(plan, &executor, &mut recorder, &FixedClock)?;

    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 2);
    match &requests[1] {
        StepRunRequest::Codex(request) => {
            let Some(conversation) = request.conversation.as_ref() else {
                panic!("missing conversation");
            };
            assert_eq!(conversation.resume_thread_id.as_deref(), Some("thread-123"));
        }
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}

#[test]
fn keeps_latest_outer_handle_in_loop() -> Result<(), Box<dyn std::error::Error>> {
    let setup = codex_exec_node(0, "setup", "Setup", Some("reviewer"))?;
    let loop_path = NodePath::root_child(1);
    let draft = action_node_at_path(
        2,
        Some("draft"),
        loop_path.child(0),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Draft")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(workflow_conversation("reviewer")?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let remediation = loop_node(1, "remediation", vec![draft], "false", 2, vec![])?;
    let plan = plan_with_nodes(vec![setup, remediation])?;
    let executor = RecordingExecutor::new(vec![
        handle_result("setup", "thread-setup"),
        handle_result("first", "thread-iter-1"),
        handle_result("second", "thread-iter-2"),
    ]);
    let mut recorder = TraceRecorder::default();

    let error = Engine
        .run_plan(plan, &executor, &mut recorder, &FixedClock)
        .expect_err("loop should exhaust");
    assert!(matches!(
        error,
        EngineError::Executor(ExecutorError::LoopExhausted { max_iterations: 2, .. })
    ));

    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 3);
    match &requests[1] {
        StepRunRequest::Codex(request) => {
            let Some(conversation) = request.conversation.as_ref() else {
                panic!("missing conversation");
            };
            assert_eq!(conversation.resume_thread_id.as_deref(), Some("thread-setup"));
        }
        other => panic!("unexpected request: {other:?}"),
    }
    match &requests[2] {
        StepRunRequest::Codex(request) => {
            let Some(conversation) = request.conversation.as_ref() else {
                panic!("missing conversation");
            };
            assert_eq!(conversation.resume_thread_id.as_deref(), Some("thread-iter-1"));
        }
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}

#[test]
fn resets_iteration_scoped_per_loop() -> Result<(), Box<dyn std::error::Error>> {
    let loop_path = NodePath::root_child(0);
    let draft = action_node_at_path(
        1,
        Some("draft"),
        loop_path.child(0),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Draft")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(conversation("reviewer", ConversationScope::Iteration)?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let fix = action_node_at_path(
        2,
        Some("fix"),
        loop_path.child(1),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Fix")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(conversation("reviewer", ConversationScope::Iteration)?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let remediation = loop_node(0, "remediation", vec![draft, fix], "false", 2, vec![])?;
    let plan = plan_with_nodes(vec![remediation])?;
    let executor = RecordingExecutor::new(vec![
        handle_result("draft-1", "thread-draft-1"),
        handle_result("fix-1", "thread-fix-1"),
        handle_result("draft-2", "thread-draft-2"),
        handle_result("fix-2", "thread-fix-2"),
    ]);
    let mut recorder = TraceRecorder::default();

    let error = Engine
        .run_plan(plan, &executor, &mut recorder, &FixedClock)
        .expect_err("loop should exhaust");
    assert!(matches!(
        error,
        EngineError::Executor(ExecutorError::LoopExhausted { max_iterations: 2, .. })
    ));

    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 4);
    assert_resume_thread(&requests[0], None);
    assert_resume_thread(&requests[1], Some("thread-draft-1"));
    assert_resume_thread(&requests[2], None);
    assert_resume_thread(&requests[3], Some("thread-draft-2"));
    Ok(())
}

#[test]
fn persists_loop_scoped_across_iterations() -> Result<(), Box<dyn std::error::Error>> {
    let loop_path = NodePath::root_child(0);
    let draft = action_node_at_path(
        1,
        Some("draft"),
        loop_path.child(0),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Draft")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(conversation("reviewer", ConversationScope::Loop)?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let fix = action_node_at_path(
        2,
        Some("fix"),
        loop_path.child(1),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Fix")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(conversation("reviewer", ConversationScope::Loop)?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let remediation = loop_node(0, "remediation", vec![draft, fix], "false", 2, vec![])?;
    let plan = plan_with_nodes(vec![remediation])?;
    let executor = RecordingExecutor::new(vec![
        handle_result("draft-1", "thread-draft-1"),
        handle_result("fix-1", "thread-fix-1"),
        handle_result("draft-2", "thread-draft-2"),
        handle_result("fix-2", "thread-fix-2"),
    ]);
    let mut recorder = TraceRecorder::default();

    let error = Engine
        .run_plan(plan, &executor, &mut recorder, &FixedClock)
        .expect_err("loop should exhaust");
    assert!(matches!(
        error,
        EngineError::Executor(ExecutorError::LoopExhausted { max_iterations: 2, .. })
    ));

    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 4);
    assert_resume_thread(&requests[0], None);
    assert_resume_thread(&requests[1], Some("thread-draft-1"));
    assert_resume_thread(&requests[2], Some("thread-fix-1"));
    assert_resume_thread(&requests[3], Some("thread-draft-2"));
    Ok(())
}

#[test]
fn merges_distinct_conversations_downstream() -> Result<(), Box<dyn std::error::Error>> {
    let fanout = parallel_node(
        0,
        "fanout",
        vec![
            vec![action_node_at_path(
                1,
                Some("draft"),
                NodePath::try_from("/0/0/0")?,
                ActionKind::Codex(CodexStep {
                    action: CodexAction::Exec(CodexExec {
                        prompt: Template::parse("Draft")?,
                        model: None,
                        mode: CodexMode::Default,
                        add_dirs: vec![],
                        persistence: crate::Persistence::Persist,
                        conversation: Some(conversation("reviewer", ConversationScope::Workflow)?),
                    }),
                }),
                ResultContract::Text,
                None,
            )?],
            vec![action_node_at_path(
                2,
                Some("fix"),
                NodePath::try_from("/0/1/0")?,
                ActionKind::Codex(CodexStep {
                    action: CodexAction::Exec(CodexExec {
                        prompt: Template::parse("Fix")?,
                        model: None,
                        mode: CodexMode::Default,
                        add_dirs: vec![],
                        persistence: crate::Persistence::Persist,
                        conversation: Some(conversation("fixer", ConversationScope::Workflow)?),
                    }),
                }),
                ResultContract::Text,
                None,
            )?],
        ],
        vec![],
    )?;
    let review = action_node_at_path(
        3,
        Some("review"),
        NodePath::root_child(1),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Review")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(conversation("reviewer", ConversationScope::Workflow)?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let finalize = action_node_at_path(
        4,
        Some("finalize"),
        NodePath::root_child(2),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Finalize")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(conversation("fixer", ConversationScope::Workflow)?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let executor = MappedExecutor::new(vec![
        ("codex_exec:Draft", handle_result("draft", "thread-draft")),
        ("codex_exec:Fix", handle_result("fix", "thread-fix")),
        ("codex_exec:Review", handle_result("review", "thread-review")),
        ("codex_exec:Finalize", handle_result("finalize", "thread-finalize")),
    ]);
    let mut recorder = TraceRecorder::default();
    let state = Engine.run_plan(
        plan_with_nodes(vec![fanout, review, finalize])?,
        &executor,
        &mut recorder,
        &FixedClock,
    )?;

    assert_eq!(state.status, RunStatus::Succeeded);
    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 4);
    let mut parallel_resumes = requests[..2]
        .iter()
        .map(|request| match request {
            StepRunRequest::Codex(request) => request
                .conversation
                .as_ref()
                .and_then(|conversation| conversation.resume_thread_id.clone()),
            other => panic!("unexpected request: {other:?}"),
        })
        .collect::<Vec<_>>();
    parallel_resumes.sort();
    assert_eq!(parallel_resumes, vec![None, None]);
    match &requests[2] {
        StepRunRequest::Codex(request) => {
            assert_eq!(
                request
                    .conversation
                    .as_ref()
                    .and_then(|conversation| conversation.resume_thread_id.as_deref()),
                Some("thread-draft")
            );
        }
        other => panic!("unexpected request: {other:?}"),
    }
    match &requests[3] {
        StepRunRequest::Codex(request) => {
            assert_eq!(
                request
                    .conversation
                    .as_ref()
                    .and_then(|conversation| conversation.resume_thread_id.as_deref()),
                Some("thread-fix")
            );
        }
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}

#[test]
fn rejects_conflicting_updates_in_loop() -> Result<(), Box<dyn std::error::Error>> {
    let loop_path = NodePath::root_child(0);
    let setup = action_node_at_path(
        1,
        Some("setup"),
        loop_path.child(0),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Setup")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(conversation("reviewer", ConversationScope::Iteration)?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let parallel = parallel_node_at_path(
        2,
        "fanout",
        loop_path.child(1),
        vec![
            vec![action_node_at_path(
                3,
                Some("draft"),
                loop_path.child(1).child(0).child(0),
                ActionKind::Codex(CodexStep {
                    action: CodexAction::Exec(CodexExec {
                        prompt: Template::parse("Draft")?,
                        model: None,
                        mode: CodexMode::Default,
                        add_dirs: vec![],
                        persistence: crate::Persistence::Persist,
                        conversation: Some(conversation("reviewer", ConversationScope::Iteration)?),
                    }),
                }),
                ResultContract::Text,
                None,
            )?],
            vec![action_node_at_path(
                4,
                Some("fix"),
                loop_path.child(1).child(1).child(0),
                ActionKind::Codex(CodexStep {
                    action: CodexAction::Exec(CodexExec {
                        prompt: Template::parse("Fix")?,
                        model: None,
                        mode: CodexMode::Default,
                        add_dirs: vec![],
                        persistence: crate::Persistence::Persist,
                        conversation: Some(conversation("reviewer", ConversationScope::Iteration)?),
                    }),
                }),
                ResultContract::Text,
                None,
            )?],
        ],
        vec![],
    )?;
    let remediation =
        loop_node_at_path(0, "remediation", loop_path, vec![setup, parallel], "true", 1, vec![])?;
    let executor = MappedExecutor::new(vec![
        ("codex_exec:Setup", handle_result("setup", "thread-setup")),
        ("codex_exec:Draft", handle_result("draft", "thread-draft")),
        ("codex_exec:Fix", handle_result("fix", "thread-fix")),
    ]);
    let mut recorder = TraceRecorder::default();

    let error = Engine
        .run_plan(plan_with_nodes(vec![remediation])?, &executor, &mut recorder, &FixedClock)
        .expect_err("parallel should reject conflicting conversation updates");
    assert!(matches!(
        error,
        EngineError::Executor(ExecutorError::ParallelConversationConflict { ref name, .. })
            if name == "reviewer"
    ));

    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 3);
    assert_resume_thread(&requests[0], None);
    let mut branch_resumes = requests[1..]
        .iter()
        .map(|request| match request {
            StepRunRequest::Codex(request) => request
                .conversation
                .as_ref()
                .and_then(|conversation| conversation.resume_thread_id.clone()),
            other => panic!("unexpected request: {other:?}"),
        })
        .collect::<Vec<_>>();
    branch_resumes.sort();
    assert_eq!(
        branch_resumes,
        vec![Some("thread-setup".to_owned()), Some("thread-setup".to_owned())]
    );
    Ok(())
}

#[test]
fn keeps_final_handle_for_downstream() -> Result<(), Box<dyn std::error::Error>> {
    let loop_path = NodePath::root_child(0);
    let draft = action_node_at_path(
        1,
        Some("draft"),
        loop_path.child(0),
        ActionKind::Codex(CodexStep {
            action: CodexAction::Exec(CodexExec {
                prompt: Template::parse("Draft")?,
                model: None,
                mode: CodexMode::Default,
                add_dirs: vec![],
                persistence: crate::Persistence::Persist,
                conversation: Some(workflow_conversation("reviewer")?),
            }),
        }),
        ResultContract::Text,
        None,
    )?;
    let remediation = loop_node(0, "remediation", vec![draft], "true", 1, vec![])?;
    let follow_up = codex_exec_node(1, "follow_up", "Follow up", Some("reviewer"))?;
    let plan = plan_with_nodes(vec![remediation, follow_up])?;
    let executor = RecordingExecutor::new(vec![
        handle_result("draft", "thread-loop"),
        handle_result("follow-up", "thread-follow-up"),
    ]);
    let mut recorder = MemoryRecorder;

    let state = Engine.run_plan(plan, &executor, &mut recorder, &FixedClock)?;

    let requests = super::fixture::lock(&executor.requests);
    assert_eq!(requests.len(), 2);
    match &requests[1] {
        StepRunRequest::Codex(request) => {
            let Some(conversation) = request.conversation.as_ref() else {
                panic!("missing conversation");
            };
            assert_eq!(conversation.resume_thread_id.as_deref(), Some("thread-loop"));
        }
        other => panic!("unexpected request: {other:?}"),
    }
    assert_eq!(
        state.workflow_conversations.get(&"reviewer".parse()?),
        Some(&ConversationHandle::Codex { thread_id: "thread-follow-up".to_owned() })
    );
    Ok(())
}

#[test]
fn clear_loop_drops_only_finished_loop_scope() -> Result<(), Box<dyn std::error::Error>> {
    let mut state = ConversationState::default();
    let binding = ConversationBinding { name: "reviewer".parse()?, scope: ConversationScope::Loop };
    let outer_path = NodePath::try_from("/0")?;
    let inner_path = NodePath::try_from("/0/0")?;
    let outer_frame = FrameContext::for_loop_iteration(&FrameContext::root(), &outer_path, 1, 2);
    let inner_frame = FrameContext::for_loop_iteration(&outer_frame, &inner_path, 1, 2);
    let mut outer_run = empty_run_state("019cc300-0000-7000-8000-000000000001")?;
    let mut inner_run = empty_run_state("019cc300-0000-7000-8000-000000000002")?;

    state.store(
        &mut outer_run,
        &outer_frame,
        &binding,
        ConversationHandle::Codex { thread_id: "outer-thread".to_owned() },
    );
    state.store(
        &mut inner_run,
        &inner_frame,
        &binding,
        ConversationHandle::Codex { thread_id: "inner-thread".to_owned() },
    );

    let inner_scope_id = outer_frame.child_loop_scope_id(&inner_path);
    state.clear_loop(&inner_scope_id);

    assert_eq!(
        state.lookup(&outer_frame, &binding),
        Some(&ConversationHandle::Codex { thread_id: "outer-thread".to_owned() })
    );
    assert!(state.lookup(&inner_frame, &binding).is_none());
    Ok(())
}

#[test]
fn iteration_scope_shared_across_parallel() -> Result<(), Box<dyn std::error::Error>> {
    let mut conversations = ConversationState::default();
    let binding =
        ConversationBinding { name: "reviewer".parse()?, scope: ConversationScope::Iteration };
    let loop_path = NodePath::try_from("/0")?;
    let parallel_path = NodePath::try_from("/0/0")?;
    let loop_frame = FrameContext::for_loop_iteration(&FrameContext::root(), &loop_path, 1, 2);
    let branch_a = FrameContext::for_parallel_branch(&loop_frame, &parallel_path, 0);
    let branch_b = FrameContext::for_parallel_branch(&loop_frame, &parallel_path, 1);
    let mut run_state = empty_run_state("019cc300-0000-7000-8000-000000000004")?;
    let handle = ConversationHandle::Codex { thread_id: "thread-123".to_owned() };

    conversations.store(&mut run_state, &branch_a, &binding, handle.clone());

    assert_eq!(conversations.lookup(&branch_b, &binding), Some(&handle));

    conversations.clear_iteration(&branch_b);
    assert!(conversations.lookup(&branch_a, &binding).is_none());
    Ok(())
}

#[test]
fn merge_keeps_distinct_conversations() -> Result<(), Box<dyn std::error::Error>> {
    let base = ConversationState::default();
    let mut merged = base.clone();
    let mut run_state = empty_run_state("019cc300-0000-7000-8000-000000000005")?;
    let root = FrameContext::root();
    let reviewer =
        ConversationBinding { name: "reviewer".parse()?, scope: ConversationScope::Workflow };
    let fixer = ConversationBinding { name: "fixer".parse()?, scope: ConversationScope::Workflow };

    let mut reviewer_branch = base.clone();
    reviewer_branch.store(
        &mut run_state,
        &root,
        &reviewer,
        ConversationHandle::Codex { thread_id: "thread-reviewer".to_owned() },
    );
    merged.merge_parallel_branch(&mut run_state, &base, &reviewer_branch)?;

    let mut fixer_branch = base.clone();
    fixer_branch.store(
        &mut run_state,
        &root,
        &fixer,
        ConversationHandle::Codex { thread_id: "thread-fixer".to_owned() },
    );
    merged.merge_parallel_branch(&mut run_state, &base, &fixer_branch)?;

    assert_eq!(
        run_state.workflow_conversations.get(&reviewer.name),
        Some(&ConversationHandle::Codex { thread_id: "thread-reviewer".to_owned() })
    );
    assert_eq!(
        run_state.workflow_conversations.get(&fixer.name),
        Some(&ConversationHandle::Codex { thread_id: "thread-fixer".to_owned() })
    );
    Ok(())
}

#[test]
fn merge_rejects_conflicting_updates() -> Result<(), Box<dyn std::error::Error>> {
    let base = ConversationState::default();
    let mut merged = base.clone();
    let mut run_state = empty_run_state("019cc300-0000-7000-8000-000000000006")?;
    let root = FrameContext::root();
    let binding =
        ConversationBinding { name: "reviewer".parse()?, scope: ConversationScope::Workflow };

    let mut first_branch = base.clone();
    first_branch.store(
        &mut run_state,
        &root,
        &binding,
        ConversationHandle::Codex { thread_id: "thread-a".to_owned() },
    );
    merged.merge_parallel_branch(&mut run_state, &base, &first_branch)?;

    let mut second_branch = base.clone();
    second_branch.store(
        &mut run_state,
        &root,
        &binding,
        ConversationHandle::Codex { thread_id: "thread-b".to_owned() },
    );
    let error = merged
        .merge_parallel_branch(&mut run_state, &base, &second_branch)
        .expect_err("parallel merge should reject conflicting handles");

    assert!(matches!(
        error,
        ExecutorError::ParallelConversationConflict { ref name, ref scope }
            if name == "reviewer" && scope == "workflow"
    ));
    Ok(())
}

#[test]
fn storing_workflow_scope_updates_persisted_run_state() -> Result<(), Box<dyn std::error::Error>> {
    let mut conversations = ConversationState::default();
    let mut run_state = empty_run_state("019cc300-0000-7000-8000-000000000003")?;
    let binding =
        ConversationBinding { name: "reviewer".parse()?, scope: ConversationScope::Workflow };

    conversations.store(
        &mut run_state,
        &FrameContext::root(),
        &binding,
        ConversationHandle::Codex { thread_id: "thread-123".to_owned() },
    );

    assert_eq!(
        run_state.workflow_conversations.get(&binding.name),
        Some(&ConversationHandle::Codex { thread_id: "thread-123".to_owned() })
    );
    Ok(())
}
