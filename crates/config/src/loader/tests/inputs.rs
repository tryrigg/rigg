use super::support::parse_and_validate_error;
use crate::ConfigError;

#[test]
fn rejects_input_type_string_shorthand() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
inputs:
  requirements: string
steps:
  - id: first
    type: shell
    with:
      command: echo hi
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidInput { message, .. }
        if message.contains("type string shorthand is not supported")));
    Ok(())
}

#[test]
fn rejects_nested_input_default() -> Result<(), Box<dyn std::error::Error>> {
    let error = parse_and_validate_error(
        "invalid.yaml",
        r#"
id: invalid
inputs:
  options:
    type: object
    properties:
      format:
        type: string
        default: text
steps:
  - id: first
    type: shell
    with:
      command: echo hi
"#,
    )?;

    assert!(matches!(error, ConfigError::InvalidInput { message, .. }
        if message.contains("nested input schemas")));
    Ok(())
}
