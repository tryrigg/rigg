use super::support::{parse_and_validate, parse_and_validate_error};
use crate::ConfigError;

#[test]
fn reexported_object_input_keeps_nested_access() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
inputs:
  user:
    type: object
    properties:
      name:
        type: string
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          user: ${{ inputs.user }}
      - else:
        steps: []
        exports:
          user: ${{ inputs.user }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.user.name }}
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 2);
    Ok(())
}

#[test]
fn reexported_env_map_keeps_nested_access() -> Result<(), Box<dyn std::error::Error>> {
    let workflow = parse_and_validate(
        "valid.yaml",
        r#"
id: valid
steps:
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          vars: ${{ env }}
      - else:
        steps: []
        exports:
          vars: ${{ env }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.vars.PATH }}
"#,
    )?;

    assert_eq!(workflow.root.nodes.len(), 2);
    Ok(())
}

#[test]
fn reexported_result_preserves_object_shape() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: fetch
    type: claude
    with:
      action: prompt
      prompt: fetch
      output_schema:
        type: object
        required: [user]
        properties:
          user:
            type: object
            required: [name]
            properties:
              name:
                type: string
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          user: ${{ steps.fetch.result.user }}
      - else:
        steps: []
        exports:
          user: ${{ steps.fetch.result.user }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.user.missing }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidReference { message, .. }
        if message.contains("is not declared")));
    Ok(())
}

#[test]
fn parenthesized_reexport_preserves_object() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: fetch
    type: claude
    with:
      action: prompt
      prompt: fetch
      output_schema:
        type: object
        required: [user]
        properties:
          user:
            type: object
            required: [name]
            properties:
              name:
                type: string
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          user: ${{ ( steps.fetch.result.user ) }}
      - else:
        steps: []
        exports:
          user: ${{ (steps.fetch.result.user) }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.user.missing }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidReference { message, .. }
        if message.contains("is not declared")));
    Ok(())
}

#[test]
fn reexported_result_preserves_array_shape() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
steps:
  - id: fetch
    type: claude
    with:
      action: prompt
      prompt: fetch
      output_schema:
        type: object
        required: [items]
        properties:
          items:
            type: array
            items:
              type: object
              required: [name]
              properties:
                name:
                  type: string
  - id: decide
    type: branch
    cases:
      - if: ${{ true }}
        steps: []
        exports:
          items: ${{ steps.fetch.result.items }}
      - else:
        steps: []
        exports:
          items: ${{ steps.fetch.result.items }}
  - id: consume
    type: shell
    with:
      command: echo ${{ steps.decide.result.items.foo }}
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidReference { message, .. }
        if message.contains("array access must use a numeric index")));
    Ok(())
}
