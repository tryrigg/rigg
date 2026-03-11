use super::super::compile::validate_workflow;
use super::super::*;
use crate::ConfigError;
use std::path::Path;

pub(super) fn parse_and_validate(
    path: &str,
    contents: &str,
) -> Result<rigg_core::ValidatedWorkflow, Box<dyn std::error::Error>> {
    let raw = RawWorkflowFile::parse(contents)?;
    let workflow_id = raw.id.parse()?;
    Ok(validate_workflow(Path::new(path), &workflow_id, raw.workflow)?)
}

pub(super) fn parse_and_validate_error(
    path: &str,
    contents: &str,
) -> Result<ConfigError, Box<dyn std::error::Error>> {
    let raw = RawWorkflowFile::parse(contents)?;
    let workflow_id = raw.id.parse()?;
    Ok(validate_workflow(Path::new(path), &workflow_id, raw.workflow)
        .err()
        .ok_or("expected validation failure")?)
}

pub(super) fn invalid_with_message(yaml: &str) -> Result<String, Box<dyn std::error::Error>> {
    let error = parse_and_validate_error("invalid.yaml", yaml)?;
    match error {
        ConfigError::InvalidWith { message, .. } => Ok(message),
        other => Err(format!("expected invalid with error, got {other:?}").into()),
    }
}
