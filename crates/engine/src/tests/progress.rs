use super::fixture::{
    FakeExecutor, FixedClock, MemoryRecorder, TraceProgress, plan_with_nodes, successful_text_step,
    text_shell_node,
};
use crate::{Engine, LiveEvent, NodeStatus};

#[test]
fn uses_node_vocabulary() -> Result<(), Box<dyn std::error::Error>> {
    let executor = FakeExecutor::new(vec![successful_text_step("line")]);
    let node = text_shell_node(0, "produce", "printf line")?;
    let plan = plan_with_nodes(vec![node])?;
    let mut recorder = MemoryRecorder;
    let mut progress = TraceProgress::default();

    Engine.run_plan_with_progress(plan, &executor, &mut recorder, &FixedClock, &mut progress)?;

    assert!(progress.events.iter().any(|event| matches!(
        event,
        LiveEvent::NodeStarted { user_id: Some(user_id), .. } if user_id.as_str() == "produce"
    )));
    assert!(progress.events.iter().any(|event| matches!(
        event,
        LiveEvent::NodeFinished {
            user_id: Some(user_id),
            status: NodeStatus::Succeeded,
            ..
        } if user_id.as_str() == "produce"
    )));
    Ok(())
}
