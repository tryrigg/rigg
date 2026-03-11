use super::fixture::{claude_node, codex_exec_node, empty_state, plan_with_nodes, text_shell_node};
use crate::context::{FrameContext, build_context};
use crate::conversations::ConversationState;
use crate::render::{render_env, render_request};
use crate::{CapturedValue, StepId, StepRunRequest};
use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;

fn render_single_node_request(
    node: crate::ValidatedNode,
    artifacts_dir: &Path,
) -> Result<(crate::EnginePlan, StepRunRequest), Box<dyn std::error::Error>> {
    let plan = plan_with_nodes(vec![node.clone()])?;
    let request =
        render_node_request(&plan, &node, &empty_state(&plan), &BTreeMap::new(), artifacts_dir)?;
    Ok((plan, request))
}

fn render_node_request(
    plan: &crate::EnginePlan,
    node: &crate::ValidatedNode,
    state: &crate::RunState,
    visible: &BTreeMap<StepId, crate::NodePath>,
    artifacts_dir: &Path,
) -> Result<StepRunRequest, Box<dyn std::error::Error>> {
    let frame = FrameContext::root();
    let env = render_env(plan, state, visible, &node.attrs, &frame)?;
    Ok(render_request(
        plan,
        node,
        &env,
        &build_context(plan, state, visible, &env, &frame),
        &ConversationState::default(),
        &frame,
        artifacts_dir,
    )?)
}

#[test]
fn canonicalizes_output_schema() -> Result<(), Box<dyn std::error::Error>> {
    let node = claude_node(
        0,
        "draft",
        "Draft",
        Some(serde_json::json!({
            "type":"object",
            "required":["markdown", "metadata"],
            "properties":{
                "markdown":{"type":"string","description":"final answer"},
                "metadata":{
                    "type":"object",
                    "required":["accepted"],
                    "properties":{
                        "accepted":{"type":"boolean"}
                    }
                }
            },
            "description": "draft response"
        })),
    )?;
    let (_, request) = render_single_node_request(node, std::env::temp_dir().as_path())?;

    match request {
        StepRunRequest::Claude(request) => {
            assert_eq!(
                request.result_schema,
                Some(serde_json::json!({
                    "type":"object",
                    "required":["markdown", "metadata"],
                    "properties":{
                        "markdown":{"type":"string"},
                        "metadata":{
                            "type":"object",
                            "required":["accepted"],
                            "properties":{
                                "accepted":{"type":"boolean"}
                            },
                            "additionalProperties": false
                        }
                    },
                    "additionalProperties": false,
                }))
            );
        }
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}

#[test]
fn uses_run_scoped_artifacts_dir() -> Result<(), Box<dyn std::error::Error>> {
    let node = codex_exec_node(0, "draft", "Draft", None)?;
    let run_artifacts_dir = std::env::temp_dir().join("rigg-test-run-artifacts");
    let (_, request) = render_single_node_request(node, run_artifacts_dir.as_path())?;

    match request {
        StepRunRequest::Codex(request) => {
            assert_eq!(request.artifacts_dir, run_artifacts_dir.join("codex"));
        }
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}

#[test]
fn resolves_relative_artifacts_dir() -> Result<(), Box<dyn std::error::Error>> {
    let node = codex_exec_node(0, "draft", "Draft", None)?;
    let mut plan = plan_with_nodes(vec![node.clone()])?;
    plan.project_root = std::env::temp_dir().join(format!(
        "rigg-artifacts-project-root-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos()
    ));
    let state = empty_state(&plan);
    let run_artifacts_dir =
        std::path::PathBuf::from(".rigg").join("runs").join("test-run").join("artifacts");
    let request =
        render_node_request(&plan, &node, &state, &BTreeMap::new(), run_artifacts_dir.as_path())?;

    match request {
        StepRunRequest::Codex(request) => {
            assert!(request.artifacts_dir.is_absolute());
            assert_eq!(
                request.artifacts_dir,
                plan.project_root.join(run_artifacts_dir).join("codex")
            );
        }
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}

#[test]
fn absolutizes_relative_artifacts_dir() -> Result<(), Box<dyn std::error::Error>> {
    let node = codex_exec_node(0, "draft", "Draft", None)?;
    let mut plan = plan_with_nodes(vec![node.clone()])?;
    plan.project_root =
        std::path::PathBuf::from(format!("rigg-relative-project-root-{}", std::process::id()));
    let state = empty_state(&plan);
    let run_artifacts_dir =
        std::path::PathBuf::from(".rigg").join("runs").join("test-run").join("artifacts");
    let request =
        render_node_request(&plan, &node, &state, &BTreeMap::new(), run_artifacts_dir.as_path())?;

    match request {
        StepRunRequest::Codex(request) => {
            assert!(request.artifacts_dir.is_absolute());
            assert_eq!(
                request.artifacts_dir,
                std::env::current_dir()?
                    .join(&plan.project_root)
                    .join(run_artifacts_dir)
                    .join("codex")
            );
        }
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}

#[test]
fn exposes_previous_step_result() -> Result<(), Box<dyn std::error::Error>> {
    let first = text_shell_node(0, "first", "echo hi")?;
    let second = text_shell_node(1, "second", "echo ${{ steps.first.result }}")?;
    let plan = plan_with_nodes(vec![first.clone(), second.clone()])?;
    let mut state = empty_state(&plan);
    let Some(node_state) = state.nodes.get_mut(&first.path) else {
        panic!("missing node state for {}", first.path);
    };
    node_state.execution.result = Some(CapturedValue::Text("done".to_owned()));
    let visible = BTreeMap::from([(StepId::from_str("first")?, first.path.clone())]);
    let request =
        render_node_request(&plan, &second, &state, &visible, std::env::temp_dir().as_path())?;

    match request {
        StepRunRequest::Shell(request) => assert_eq!(request.command, "echo done"),
        other => panic!("unexpected request: {other:?}"),
    }
    Ok(())
}
