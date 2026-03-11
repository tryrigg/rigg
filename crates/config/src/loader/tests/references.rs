use super::support::{parse_and_validate, parse_and_validate_error};
use crate::ConfigError;

#[test]
fn rejects_undeclared_input_reference() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: first
    type: shell
    with:
      command: echo ${{ inputs.requirements }}
"#,
    )?;
    assert!(matches!(error, ConfigError::InvalidReference { .. }));
    Ok(())
}

#[test]
fn rejects_run_references_outside_loop_frames() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: first
    type: shell
    with:
      command: echo ${{ run.iteration }}
"#,
    )?;
    assert!(matches!(error, ConfigError::InvalidExprRoot { root, .. } if root == "run"));
    Ok(())
}

#[test]
fn run_context_accepts_declared_metadata() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: remediation
    type: loop
    max: 2
    until: ${{ run.unknown == null }}
    steps:
      - id: fix
        type: shell
        with:
          command: echo ${{ run.iteration }}
"#,
    )?;
    assert!(matches!(error, ConfigError::InvalidReference { message, .. }
        if message == "`run` only exposes `iteration`, `max_iterations`, and `node_path`"));
    Ok(())
}

#[test]
fn allows_run_refs_in_loop_body_and_exports() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: remediation
    type: loop
    max: 2
    until: ${{ run.iteration == run.max_iterations }}
    steps:
      - id: fix
        type: shell
        with:
          command: echo ${{ run.node_path }}:${{ run.iteration }}/${{ run.max_iterations }}
    exports:
      loop_path: ${{ run.node_path }}
"#,
    )?;

    let rigg_core::NodeKind::Loop(loop_node) = &workflow.root.nodes[0].kind else {
        panic!("expected loop node");
    };
    assert_eq!(loop_node.exports.as_ref().map(|exports| exports.fields.len()), Some(1));
    Ok(())
}

#[test]
fn allows_nested_array_ref_from_result() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: collect
    type: claude
    with:
      action: prompt
      prompt: hello
      output_schema:
        type: object
        properties:
          changes:
            type: array
            items:
              type: object
              properties:
                path:
                  type: string
  - id: use
    type: shell
    with:
      command: echo ${{ steps.collect.result.changes.0.path }}
"#,
    )?;
    assert_eq!(workflow.root.nodes.len(), 2);
    Ok(())
}

#[test]
fn rejects_undeclared_nested_input_reference() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
inputs:
  user:
    type: object
    properties:
      name:
        type: string
steps:
  - id: first
    type: shell
    with:
      command: echo ${{ inputs.user.email }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidReference { message, .. }
        if message == "`inputs.user.email` is not declared"));
    Ok(())
}

#[test]
fn allows_nested_array_ref_from_input() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
inputs:
  exclude_paths:
    type: array
    items:
      type: string
steps:
  - id: first
    type: shell
    with:
      command: echo ${{ inputs.exclude_paths.0 }}
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 1);
    Ok(())
}

#[test]
fn rejects_non_numeric_array_ref_from_input() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
inputs:
  exclude_paths:
    type: array
    items:
      type: string
steps:
  - id: first
    type: shell
    with:
      command: echo ${{ inputs.exclude_paths.first }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidReference { message, .. }
        if message == "`inputs.exclude_paths` array access must use a numeric index"));
    Ok(())
}
