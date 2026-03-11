use super::{ConfigError, FieldSite};
use rigg_core::{InputSchema, StepId};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::str::FromStr;

pub(super) fn parse_step_id(
    path: &Path,
    workflow_id: &rigg_core::WorkflowId,
    step_index: usize,
    location: crate::syntax::SourceLocation,
    id: Option<String>,
) -> Result<Option<StepId>, ConfigError> {
    let Some(id) = id else {
        return Ok(None);
    };
    let step_id = StepId::from_str(&id).map_err(|_| ConfigError::InvalidStepId {
        path: path.to_path_buf(),
        location,
        workflow_id: workflow_id.to_string(),
        step_index,
        step_id: id.clone(),
    })?;
    Ok(Some(step_id))
}

pub(super) fn validate_step_id(
    path: &Path,
    workflow_id: &rigg_core::WorkflowId,
    step_index: usize,
    location: crate::syntax::SourceLocation,
    id: Option<String>,
    seen_step_ids: &mut BTreeSet<StepId>,
) -> Result<Option<StepId>, ConfigError> {
    let original_id = id.clone();
    let Some(step_id) = parse_step_id(path, workflow_id, step_index, location, id)? else {
        return Ok(None);
    };
    if !seen_step_ids.insert(step_id.clone()) {
        return Err(ConfigError::DuplicateStepId {
            path: path.to_path_buf(),
            location,
            workflow_id: workflow_id.to_string(),
            step_id: original_id.unwrap_or_else(|| step_id.to_string()),
        });
    }
    Ok(Some(step_id))
}

pub(super) fn compile_input_schemas(
    site: FieldSite<'_>,
    inputs: BTreeMap<String, JsonValue>,
) -> Result<BTreeMap<String, InputSchema>, ConfigError> {
    inputs
        .into_iter()
        .map(|(key, value)| {
            if !value.is_object() {
                return Err(ConfigError::InvalidInput {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    workflow_id: site.workflow_id.to_string(),
                    input: key,
                    message: if value.is_string() {
                        "input must be a JSON Schema object; type string shorthand is not supported"
                            .to_owned()
                    } else {
                        "input must be a JSON Schema object".to_owned()
                    },
                });
            }
            let schema =
                InputSchema::parse_at(&value, format!("inputs.{key}")).map_err(|error| {
                    ConfigError::InvalidInput {
                        path: site.path.to_path_buf(),
                        location: site.location,
                        workflow_id: site.workflow_id.to_string(),
                        input: key.clone(),
                        message: error.to_string(),
                    }
                })?;
            Ok((key, schema))
        })
        .collect()
}
