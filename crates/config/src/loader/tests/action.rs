use super::support::{invalid_with_message, parse_and_validate, parse_and_validate_error};
use crate::ConfigError;

fn check_rejects_invalid_with(yaml: &str) -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error("invalid.yaml", yaml)?;
    assert!(matches!(error, ConfigError::InvalidWith { .. }));
    Ok(())
}

#[test]
fn shell_defaults_to_text_result_contract() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: produce
    type: shell
    with:
      command: echo hi
"#,
    )?;
    let node = &workflow.root.nodes[0];
    let rigg_core::NodeKind::Action(action) = &node.kind else {
        panic!("expected action node");
    };
    assert!(matches!(action.result_contract, rigg_core::ResultContract::Text));
    Ok(())
}

#[test]
fn claude_output_schema_sets_json_contract() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: judge
    type: claude
    with:
      action: prompt
      prompt: hello
      output_schema:
        type: object
        required: [accepted_count]
        properties:
          accepted_count:
            type: integer
"#,
    )?;
    let node = &workflow.root.nodes[0];
    let rigg_core::NodeKind::Action(action) = &node.kind else {
        panic!("expected action node");
    };
    assert!(matches!(action.result_contract, rigg_core::ResultContract::Json { schema: Some(_) }));
    Ok(())
}

#[test]
fn rejects_output_schema_without_properties() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_invalid_with(
        r#"
id: invalid
steps:
  - id: judge
    type: claude
    with:
      action: prompt
      prompt: hello
      output_schema:
        type: object
"#,
    )
}

#[test]
fn rejects_output_schema_with_untyped_property() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_invalid_with(
        r#"
id: invalid
steps:
  - id: judge
    type: codex
    with:
      action: exec
      prompt: hello
      output_schema:
        type: object
        properties:
          accepted_count: {}
"#,
    )
}

#[test]
fn rejects_nested_object_without_properties() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_invalid_with(
        r#"
id: invalid
steps:
  - id: judge
    type: claude
    with:
      action: prompt
      prompt: hello
      output_schema:
        type: object
        properties:
          meta:
            type: object
"#,
    )
}

#[test]
fn rejects_output_schema_with_invalid_array_items() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_invalid_with(
        r#"
id: invalid
steps:
  - id: judge
    type: codex
    with:
      action: exec
      prompt: hello
      output_schema:
        type: object
        properties:
          changes:
            type: array
            items: {}
"#,
    )
}

#[test]
fn rejects_non_object_properties_path() -> Result<(), Box<dyn std::error::Error>> {
    let message = invalid_with_message(
        r#"
id: invalid
steps:
  - id: judge
    type: claude
    with:
      action: prompt
      prompt: hello
      output_schema:
        type: object
        properties: []
"#,
    )?;
    assert_eq!(message, "`with.output_schema.properties` must be an object");
    Ok(())
}

#[test]
fn rejects_unknown_required_property() -> Result<(), Box<dyn std::error::Error>> {
    let message = invalid_with_message(
        r#"
id: invalid
steps:
  - id: judge
    type: claude
    with:
      action: prompt
      prompt: hello
      output_schema:
        type: object
        required: [accepted_count]
        properties:
          fix_brief:
            type: string
"#,
    )?;
    assert_eq!(
        message,
        "`with.output_schema.required` references undeclared property `accepted_count`"
    );
    Ok(())
}

#[test]
fn rejects_non_string_required_entries_path() -> Result<(), Box<dyn std::error::Error>> {
    let message = invalid_with_message(
        r#"
id: invalid
steps:
  - id: judge
    type: codex
    with:
      action: exec
      prompt: hello
      output_schema:
        type: object
        required: [1]
        properties:
          accepted_count:
            type: integer
"#,
    )?;
    assert_eq!(message, "`with.output_schema.required` must be an array of strings");
    Ok(())
}

#[test]
fn rejects_review_without_required_commit_value() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_invalid_with(
        r#"
id: invalid
steps:
  - id: review
    type: codex
    with:
      action: review
      target: commit
"#,
    )
}

#[test]
fn rejects_exec_with_review_only_fields() -> Result<(), Box<dyn std::error::Error>> {
    check_rejects_invalid_with(
        r#"
id: invalid
steps:
  - id: exec
    type: codex
    with:
      action: exec
      prompt: hello
      title: bug sweep
"#,
    )
}

#[test]
fn accepts_review_commit_scope() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: review
    type: codex
    with:
      action: review
      target: commit
      commit: abc123
      title: Bug sweep
      add_dirs:
        - docs
      persist: false
"#,
    )?;
    let node = &workflow.root.nodes[0];
    let rigg_core::NodeKind::Action(action) = &node.kind else {
        panic!("expected action node");
    };
    match &action.action {
        rigg_core::ActionKind::Codex(step) => match &step.action {
            rigg_core::CodexAction::Review(review) => {
                assert!(matches!(review.scope, rigg_core::ReviewScope::Commit(_)));
                assert!(review.title.is_some());
                assert_eq!(review.add_dirs.len(), 1);
                assert!(matches!(review.persistence, rigg_core::Persistence::Ephemeral));
            }
            other => panic!("unexpected codex action: {other:?}"),
        },
        other => panic!("unexpected action: {other:?}"),
    }
    assert!(matches!(action.result_contract, rigg_core::ResultContract::Review { .. }));
    Ok(())
}

#[test]
fn review_result_fields_are_available_at_compile_time() -> Result<(), Box<dyn std::error::Error>> {
    parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: review
    type: codex
    with:
      action: review
      target: uncommitted
  - id: summarize
    type: shell
    with:
      command: echo ${{ steps.review.result.overall_explanation }} ${{ steps.review.result.findings.0.title }}
"#,
    )?;

    Ok(())
}
