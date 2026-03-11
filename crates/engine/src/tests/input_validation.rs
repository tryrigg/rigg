use super::fixture::{input_schema, plan_with_nodes, text_shell_node};
use crate::{EngineError, ValidatedWorkflow, ValidationError};
use std::collections::BTreeMap;

#[test]
fn rejects_missing_required_input() -> Result<(), Box<dyn std::error::Error>> {
    let plan = plan_with_nodes(vec![text_shell_node(0, "produce", "echo hi")?])?;
    let result = crate::result::normalize_invocation_inputs(&plan.workflow, &serde_json::json!({}));
    assert!(matches!(result, Err(EngineError::Validation(ValidationError::MissingInput { .. }))));
    Ok(())
}

#[test]
fn applies_input_defaults() -> Result<(), Box<dyn std::error::Error>> {
    let plan = plan_with_nodes(vec![text_shell_node(0, "produce", "echo hi")?])?;
    let schema = input_schema(serde_json::json!({
        "type": "string",
        "default": "fallback",
    }))?;
    let workflow = ValidatedWorkflow {
        inputs: BTreeMap::from([("requirements".to_owned(), schema)]),
        ..plan.workflow
    };

    let normalized = crate::result::normalize_invocation_inputs(&workflow, &serde_json::json!({}))?;
    assert_eq!(normalized, serde_json::json!({ "requirements": "fallback" }));
    Ok(())
}

#[test]
fn rejects_input_constraint_violations() -> Result<(), Box<dyn std::error::Error>> {
    let plan = plan_with_nodes(vec![text_shell_node(0, "produce", "echo hi")?])?;
    let schema = input_schema(serde_json::json!({
        "type": "array",
        "items": { "type": "string" },
        "minItems": 1,
    }))?;
    let workflow = ValidatedWorkflow {
        inputs: BTreeMap::from([("requirements".to_owned(), schema)]),
        ..plan.workflow
    };

    let result = crate::result::normalize_invocation_inputs(
        &workflow,
        &serde_json::json!({ "requirements": [] }),
    );
    assert!(matches!(
        result,
        Err(EngineError::Validation(ValidationError::ItemCountViolation { .. }))
    ));
    Ok(())
}
