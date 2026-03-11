use super::fixture::{
    FakeExecutor, FixedClock, TraceRecorder, group_node, plan_with_nodes, successful_text_step,
    text_shell_node,
};
use crate::{CapturedValue, Engine, NodeStatus, ResultShape};

#[test]
fn runs_body_and_exports_result() -> Result<(), Box<dyn std::error::Error>> {
    let summarize = group_node(
        0,
        "summarize",
        vec![text_shell_node(10, "inner", "printf inner")?],
        vec![("summary", "steps.inner.result", ResultShape::String)],
    )?;
    let consume = text_shell_node(1, "consume", "echo ${{ steps.summarize.result.summary }}")?;
    let executor =
        FakeExecutor::new(vec![successful_text_step("inner"), successful_text_step("ok")]);
    let state = Engine.run_plan(
        plan_with_nodes(vec![summarize.clone(), consume])?,
        &executor,
        &mut TraceRecorder::default(),
        &FixedClock,
    )?;

    let Some(group_state) = state.nodes.get(&summarize.path) else {
        panic!("missing group node state");
    };
    assert_eq!(group_state.execution.status, NodeStatus::Succeeded);
    assert_eq!(
        group_state.execution.result,
        Some(CapturedValue::Json(serde_json::json!({ "summary": "inner" })))
    );
    Ok(())
}
