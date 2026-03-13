use super::fixture::{action_node, claude_node, shell_node};
use crate::result::finalize_result;
use crate::{
    ActionKind, CapturedValue, EngineError, OutputType, ResultContract, ResultError, ShellOutput,
    ShellStep, Template, ValidatedNode,
};
use rigg_core::codex_review_result_schema;

fn check_finalize_error(
    node: &ValidatedNode,
    result: Option<CapturedValue>,
    check: impl FnOnce(EngineError),
) {
    let error =
        finalize_result(node, result.as_ref()).expect_err("result finalization should fail");
    check(error);
}

#[test]
fn parses_shell_json_stdout() -> Result<(), Box<dyn std::error::Error>> {
    let node = shell_node(
        0,
        "produce",
        "printf '{\"count\":1}'",
        ShellOutput::Json,
        ResultContract::Json { schema: None },
        None,
    )?;
    let result = finalize_result(&node, Some(&CapturedValue::Text(r#"{"count":1}"#.to_owned())))?;
    assert_eq!(result, Some(CapturedValue::Json(serde_json::json!({"count":1}))));
    Ok(())
}

#[test]
fn rejects_missing_nested_required_field() -> Result<(), Box<dyn std::error::Error>> {
    let node = claude_node(
        0,
        "review",
        "Review",
        Some(serde_json::json!({
            "type":"object",
            "required":["meta"],
            "properties":{
                "meta":{
                    "type":"object",
                    "required":["answer"],
                    "properties":{
                        "answer":{"type":"string"}
                    }
                }
            }
        })),
    )?;

    check_finalize_error(
        &node,
        Some(CapturedValue::Json(serde_json::json!({
            "meta": {}
        }))),
        |error| {
            assert!(matches!(
                error,
                EngineError::Result(ResultError::MissingRequiredField { field, .. })
                    if field == "meta.answer"
            ));
        },
    );
    Ok(())
}

#[test]
fn rejects_nested_type_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let node = claude_node(
        0,
        "review",
        "Review",
        Some(serde_json::json!({
            "type":"object",
            "required":["meta"],
            "properties":{
                "meta":{
                    "type":"object",
                    "required":["score"],
                    "properties":{
                        "score":{"type":"integer"}
                    }
                }
            }
        })),
    )?;

    check_finalize_error(
        &node,
        Some(CapturedValue::Json(serde_json::json!({
            "meta": { "score": "high" }
        }))),
        |error| {
            assert!(matches!(
                error,
                EngineError::Result(ResultError::ResultTypeMismatch { output, expected, .. })
                    if output == "meta.score" && expected == OutputType::Integer
            ));
        },
    );
    Ok(())
}

#[test]
fn rejects_array_item_type_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let node = claude_node(
        0,
        "review",
        "Review",
        Some(serde_json::json!({
            "type":"object",
            "properties":{
                "changes":{
                    "type":"array",
                    "items":{"type":"integer"}
                }
            }
        })),
    )?;

    check_finalize_error(
        &node,
        Some(CapturedValue::Json(serde_json::json!({
            "changes": ["oops"]
        }))),
        |error| {
            assert!(matches!(
                error,
                EngineError::Result(ResultError::ResultTypeMismatch { output, expected, .. })
                    if output == "changes[0]" && expected == OutputType::Integer
            ));
        },
    );
    Ok(())
}

#[test]
fn rejects_missing_structured_result() -> Result<(), Box<dyn std::error::Error>> {
    let node = claude_node(
        0,
        "judge",
        "Judge",
        Some(serde_json::json!({
            "type":"object",
            "required":["accepted_count"],
            "properties":{
                "accepted_count":{"type":"integer"}
            }
        })),
    )?;

    check_finalize_error(&node, None, |error| {
        assert!(matches!(
            error,
            EngineError::Result(ResultError::MissingStructuredResult { node }) if node == "judge"
        ));
    });
    Ok(())
}

#[test]
fn review_contract_allows_missing_priority() -> Result<(), Box<dyn std::error::Error>> {
    let node = action_node(
        0,
        Some("review"),
        ActionKind::Shell(ShellStep {
            command: Template::parse("echo review")?,
            result_mode: ShellOutput::Json,
        }),
        ResultContract::Review { schema: codex_review_result_schema() },
        None,
    )?;

    let result = finalize_result(
        &node,
        Some(&CapturedValue::Json(serde_json::json!({
            "findings": [
                {
                    "title": "[P1] Example finding",
                    "body": "Body",
                    "confidence_score": 0.9,
                    "code_location": {
                        "absolute_file_path": "/tmp/file.rs",
                        "line_range": { "start": 10, "end": 12 }
                    }
                }
            ],
            "overall_correctness": "patch is incorrect",
            "overall_explanation": "Explanation",
            "overall_confidence_score": 0.8
        }))),
    )?;

    assert!(matches!(result, Some(CapturedValue::Json(_))));
    Ok(())
}
