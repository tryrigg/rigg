use super::fixture::{
    CustomLogPathRecorder, FakeExecutor, FixedClock, StaticExecutor, TraceRecorder,
    codex_exec_node, step_result, successful_text_step, text_shell_node,
    text_step_with_provider_events, workflow_conversation,
};
use crate::conversation::ConversationProvider;
use crate::progress::ProviderEvent;
use crate::{CapturedValue, Engine, EngineError, ExecutorError, NodeStatus, RunEvent};

#[test]
fn runs_nodes_and_records_events() -> Result<(), Box<dyn std::error::Error>> {
    let executor = FakeExecutor::new(vec![successful_text_step("ok")]);
    let mut recorder = TraceRecorder::default();
    let node = text_shell_node(0, "produce", "printf ok")?;
    let plan = super::fixture::plan_with_nodes(vec![node.clone()])?;

    let state = Engine.run_plan(plan, &executor, &mut recorder, &FixedClock)?;

    let Some(node_state) = state.nodes.get(&node.path) else {
        panic!("missing node state for {}", node.path);
    };
    assert_eq!(node_state.execution.status, NodeStatus::Succeeded);
    assert_eq!(node_state.execution.result, Some(CapturedValue::Text("ok".to_owned())));
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeStarted { node_path, .. } if node_path == &node.path
    )));
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeFinished(event) if event.node_path == node.path
    )));
    Ok(())
}

#[test]
fn persists_provider_details_into_node_logs() -> Result<(), Box<dyn std::error::Error>> {
    let node = codex_exec_node(0, "draft", "fix it", None)?;
    let mut recorder = CustomLogPathRecorder::default();
    let executor = StaticExecutor::new(Ok(text_step_with_provider_events(
        0,
        "final answer",
        "",
        vec![
            ProviderEvent::Status {
                provider: ConversationProvider::Claude,
                message: "Scanning files...".to_owned(),
            },
            ProviderEvent::ToolUse {
                provider: ConversationProvider::Claude,
                tool: "read_file".to_owned(),
                detail: Some("path=src/main.rs".to_owned()),
            },
            ProviderEvent::Error {
                provider: ConversationProvider::Claude,
                message: "sandbox denied".to_owned(),
            },
        ],
    )));

    Engine.run_plan(
        super::fixture::plan_with_nodes(vec![node])?,
        &executor,
        &mut recorder,
        &FixedClock,
    )?;

    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[progress] Scanning files...")
    }));
    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[tool] read_file path=src/main.rs")
    }));
    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stderr.log") && chunk.contains("[error] sandbox denied")
    }));
    Ok(())
}

#[test]
fn keeps_codex_provider_messages_out_of_persisted_logs() -> Result<(), Box<dyn std::error::Error>> {
    let node = codex_exec_node(0, "draft", "fix it", None)?;
    let mut recorder = CustomLogPathRecorder::default();
    let executor = StaticExecutor::new(Ok(step_result(
        1,
        "Scanning files...\nfinal answer\nsandbox denied",
        "warning",
        None,
        None,
        vec![
            ProviderEvent::Status {
                provider: ConversationProvider::Codex,
                message: "Scanning files...".to_owned(),
            },
            ProviderEvent::ToolUse {
                provider: ConversationProvider::Codex,
                tool: "read_file".to_owned(),
                detail: Some("path=src/main.rs".to_owned()),
            },
            ProviderEvent::Error {
                provider: ConversationProvider::Codex,
                message: "sandbox denied".to_owned(),
            },
        ],
    )));

    let state = Engine.run_plan(
        super::fixture::plan_with_nodes(vec![node.clone()])?,
        &executor,
        &mut recorder,
        &FixedClock,
    )?;

    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeFinished(event)
            if event.node_path == node.path
                && event.status == NodeStatus::Failed
                && event.exit_code == Some(1)
    )));
    assert_eq!(state.status, crate::RunStatus::Failed);
    assert_eq!(state.reason, Some(crate::RunReason::StepFailed));
    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[tool] read_file path=src/main.rs")
    }));
    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log")
            && chunk.contains("Scanning files...\nfinal answer\nsandbox denied")
    }));
    assert!(!recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[progress] Scanning files...")
    }));
    assert!(!recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stderr.log") && chunk.contains("[error] sandbox denied")
    }));
    assert!(
        recorder
            .logs
            .iter()
            .any(|(path, chunk)| path.ends_with(".stderr.log") && chunk.contains("warning"))
    );
    Ok(())
}

#[test]
fn persists_logs_before_missing_conversation_handle_error() -> Result<(), Box<dyn std::error::Error>>
{
    let mut node = codex_exec_node(0, "draft", "fix it", None)?;
    let crate::NodeKind::Action(action) = &mut node.kind else {
        panic!("expected action node");
    };
    let crate::ActionKind::Codex(step) = &mut action.action else {
        panic!("expected codex action");
    };
    match &mut step.action {
        crate::CodexAction::Exec(exec) => {
            exec.conversation = Some(workflow_conversation("thread")?);
            exec.persistence = crate::Persistence::Persist;
        }
        other => panic!("unexpected codex action: {other:?}"),
    }

    let mut recorder = CustomLogPathRecorder::default();
    let executor = StaticExecutor::new(Ok(text_step_with_provider_events(
        0,
        "final answer",
        "warning",
        vec![
            ProviderEvent::Status {
                provider: ConversationProvider::Codex,
                message: "Scanning files...".to_owned(),
            },
            ProviderEvent::Error {
                provider: ConversationProvider::Codex,
                message: "missing thread id".to_owned(),
            },
        ],
    )));
    let error = Engine
        .run_plan(
            super::fixture::plan_with_nodes(vec![node.clone()])?,
            &executor,
            &mut recorder,
            &FixedClock,
        )
        .expect_err("run should fail without a conversation handle");

    assert!(matches!(
        error,
        EngineError::Executor(ExecutorError::MissingConversationHandle { tool: "codex" })
    ));
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeFinished(event)
            if event.node_path == node.path && event.status == NodeStatus::Failed
    )));
    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[progress] Scanning files...")
    }));
    assert!(
        recorder
            .logs
            .iter()
            .any(|(path, chunk)| path.ends_with(".stdout.log") && chunk.contains("final answer"))
    );
    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[error] missing thread id")
    }));
    assert!(
        recorder
            .logs
            .iter()
            .any(|(path, chunk)| path.ends_with(".stderr.log") && chunk.contains("warning"))
    );
    assert!(!recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stderr.log") && chunk.contains("[error] missing thread id")
    }));
    Ok(())
}

#[test]
fn persists_partial_execution_logs_before_post_process_error()
-> Result<(), Box<dyn std::error::Error>> {
    let node = codex_exec_node(0, "draft", "fix it", None)?;
    let mut recorder = CustomLogPathRecorder::default();
    let parse_error =
        serde_json::from_str::<serde_json::Value>("{").expect_err("expected malformed JSON");
    let executor =
        StaticExecutor::new(Err(EngineError::Executor(ExecutorError::ParseJsonOutput {
            tool: "codex",
            source: parse_error,
        })
        .with_partial_execution(step_result(
            0,
            "Summarizing changes...\npartial answer\ninvalid JSON",
            "parse failed",
            None,
            None,
            vec![
                ProviderEvent::Status {
                    provider: ConversationProvider::Codex,
                    message: "Summarizing changes...".to_owned(),
                },
                ProviderEvent::Error {
                    provider: ConversationProvider::Codex,
                    message: "invalid JSON".to_owned(),
                },
            ],
        ))));
    let error = Engine
        .run_plan(
            super::fixture::plan_with_nodes(vec![node.clone()])?,
            &executor,
            &mut recorder,
            &FixedClock,
        )
        .expect_err("run should fail on post-process error");

    assert!(matches!(error, EngineError::Executor(ExecutorError::StepPostProcess { .. })));
    assert!(recorder.events.iter().any(|record| matches!(
        &record.event,
        RunEvent::NodeFinished(event)
            if event.node_path == node.path
                && event.status == NodeStatus::Failed
                && event.exit_code == Some(0)
    )));
    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log")
            && chunk.contains("Summarizing changes...\npartial answer\ninvalid JSON")
    }));
    assert!(!recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[progress] Summarizing changes...")
    }));
    assert!(!recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[error] invalid JSON")
    }));
    assert!(!recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stderr.log") && chunk.contains("[error] invalid JSON")
    }));
    assert!(
        recorder.logs.iter().any(|(path, chunk)| {
            path.ends_with(".stderr.log") && chunk.contains("parse failed")
        })
    );
    Ok(())
}

#[test]
fn preserves_codex_provider_messages_when_stdout_only_quotes_them()
-> Result<(), Box<dyn std::error::Error>> {
    let node = codex_exec_node(0, "draft", "fix it", None)?;
    let mut recorder = CustomLogPathRecorder::default();
    let executor = StaticExecutor::new(Ok(text_step_with_provider_events(
        0,
        "Final answer: the earlier invalid JSON issue is now fixed.",
        "",
        vec![ProviderEvent::Error {
            provider: ConversationProvider::Codex,
            message: "invalid JSON".to_owned(),
        }],
    )));

    Engine.run_plan(
        super::fixture::plan_with_nodes(vec![node])?,
        &executor,
        &mut recorder,
        &FixedClock,
    )?;

    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log") && chunk.contains("[error] invalid JSON")
    }));
    assert!(recorder.logs.iter().any(|(path, chunk)| {
        path.ends_with(".stdout.log")
            && chunk.contains("Final answer: the earlier invalid JSON issue is now fixed.")
    }));
    Ok(())
}
