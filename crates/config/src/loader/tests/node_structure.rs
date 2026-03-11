use super::support::{parse_and_validate, parse_and_validate_error};
use crate::ConfigError;
use std::fs;

#[test]
fn allows_missing_node_id_when_unreferenced() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - type: shell
    with:
      command: echo hi
"#,
    )?;
    assert!(workflow.root.nodes[0].user_id.is_none());
    Ok(())
}

#[test]
fn rejects_action_nodes_with_control_children() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: run
    type: shell
    with:
      command: echo hi
    steps:
      - type: shell
        with:
          command: echo nested
"#,
    )?;
    assert!(matches!(error, ConfigError::InvalidWith { .. }));
    Ok(())
}

#[test]
fn rejects_invalid_branch_case_structure() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: decide
    type: branch
    cases:
      - else:
        if: ${{ true }}
        steps: []
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidWith { message, .. }
        if message == "`cases[0]` cannot set both `else` and `if`"));
    Ok(())
}

#[test]
fn rejects_invalid_parallel_shape() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: fanout
    type: parallel
    steps:
      - id: lint
        type: shell
        with:
          command: echo lint
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidWith { message, .. }
        if message.contains("`parallel` requires `branches`")));
    Ok(())
}

#[test]
fn rejects_invalid_workflow_id_when_loading() -> Result<(), Box<dyn std::error::Error>> {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("rigg-config-invalid-workflow-{suffix}"));
    fs::create_dir_all(root.join(".rigg"))?;
    fs::write(
        root.join(".rigg").join("invalid.yaml"),
        r#"
id: bad workflow
steps:
  - id: build
    type: shell
    with:
      command: echo hi
"#,
    )?;

    let error = crate::load_workspace(&root).err().ok_or("expected validation failure")?;
    assert!(matches!(error, ConfigError::InvalidWorkflowId { .. }));
    Ok(())
}
