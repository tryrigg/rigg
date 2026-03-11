mod action;
mod compile;
mod expr;

#[cfg(test)]
mod tests;

use crate::compile::ValidatedWorkspace;
use crate::source::LoadedWorkspace;
use crate::syntax::{RawWorkflowFile, SourceLocation};
use rigg_core::{InputSchema, ResultShape, WorkflowId};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("could not find `.rigg/*.yaml` from `{start}`")]
    NotFound { start: PathBuf },
    #[error("failed to read config file `{path}`: {source}")]
    ReadFile { path: PathBuf, source: std::io::Error },
    #[error("failed to parse YAML in `{path}` at {location}: {message}")]
    ParseFile { path: PathBuf, location: SourceLocation, message: String },
    #[error("workflow `{workflow_id}` is defined more than once (`{first}` and `{second}`)")]
    DuplicateWorkflow { workflow_id: String, first: PathBuf, second: PathBuf },
    #[error("workflow `{workflow_id}` has invalid id in `{path}` at {location}")]
    InvalidWorkflowId { path: PathBuf, location: SourceLocation, workflow_id: String },
    #[error("workflow `{workflow_id}` has no steps in `{path}` at {location}")]
    EmptySteps { path: PathBuf, location: SourceLocation, workflow_id: String },
    #[error(
        "node {step_index} in workflow `{workflow_id}` has invalid id `{step_id}` in `{path}` at {location}"
    )]
    InvalidStepId {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        step_index: usize,
        step_id: String,
    },
    #[error("workflow `{workflow_id}` has duplicate step id `{step_id}` in `{path}` at {location}")]
    DuplicateStepId {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        step_id: String,
    },
    #[error(
        "node {step_index} in workflow `{workflow_id}` uses unsupported type `{step_type}` in `{path}` at {location}"
    )]
    UnsupportedStepType {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        step_index: usize,
        step_type: String,
    },
    #[error(
        "node {step_index} in workflow `{workflow_id}` has invalid `with` for `{step_type}` in `{path}` at {location}: {message}"
    )]
    InvalidWith {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        step_index: usize,
        step_type: String,
        message: String,
    },
    #[error(
        "node {step_index} in workflow `{workflow_id}` must use `${{ ... }}` for `{field}` in `{path}` at {location}"
    )]
    InvalidExprTemplate {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        step_index: usize,
        field: String,
    },
    #[error(
        "workflow `{workflow_id}` references invisible or future step `{step_id}` in `{path}` at {location}"
    )]
    ForwardStepReference {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        step_id: String,
    },
    #[error("workflow `{workflow_id}` cannot use `{root}` in `{field}` in `{path}` at {location}")]
    InvalidExprRoot {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        field: String,
        root: String,
    },
    #[error(
        "workflow `{workflow_id}` has invalid reference in `{field}` in `{path}` at {location}: {message}"
    )]
    InvalidReference {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        field: String,
        message: String,
    },
    #[error(
        "workflow `{workflow_id}` has invalid input `{input}` in `{path}` at {location}: {message}"
    )]
    InvalidInput {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        input: String,
        message: String,
    },
    #[error("workflow `{workflow_id}` has invalid expression in `{path}` at {location}: {source}")]
    Expr {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        #[source]
        source: Box<rigg_core::ExprError>,
    },
    #[error("workflow `{workflow_id}` has invalid template in `{path}` at {location}: {source}")]
    Template {
        path: PathBuf,
        location: SourceLocation,
        workflow_id: String,
        #[source]
        source: Box<rigg_core::TemplateError>,
    },
}

#[derive(Clone, Copy)]
struct FieldSite<'a> {
    path: &'a Path,
    workflow_id: &'a WorkflowId,
    step_index: usize,
    location: SourceLocation,
}

#[derive(Clone, Copy)]
struct ExprRules<'a> {
    allowed_roots: &'a [rigg_core::ExprRoot],
    workflow_inputs: &'a BTreeMap<String, InputSchema>,
    known_steps: &'a BTreeMap<String, ResultShape>,
    run_context: RunContext,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RunContext {
    Unavailable,
    LoopFrame,
}

pub(crate) fn compile_workspace(
    workspace: LoadedWorkspace,
) -> Result<ValidatedWorkspace, ConfigError> {
    let LoadedWorkspace { project_root, rigg_dir, sources } = workspace;
    let mut parsed_files = Vec::with_capacity(sources.len());
    let mut ids = BTreeMap::new();
    for file in &sources {
        let parsed =
            RawWorkflowFile::parse(&file.contents).map_err(|error| ConfigError::ParseFile {
                path: file.path.clone(),
                location: error.location().map(Into::into).unwrap_or_default(),
                message: error.to_string(),
            })?;
        if let Some(first) = ids.insert(parsed.id.clone(), file.path.clone()) {
            return Err(ConfigError::DuplicateWorkflow {
                workflow_id: parsed.id,
                first,
                second: file.path.clone(),
            });
        }
        parsed_files.push((file.path.clone(), parsed));
    }

    let mut workflows = BTreeMap::new();
    for (path, parsed) in parsed_files {
        let workflow_id =
            WorkflowId::from_str(&parsed.id).map_err(|_| ConfigError::InvalidWorkflowId {
                path: path.clone(),
                location: parsed.workflow.location,
                workflow_id: parsed.id.clone(),
            })?;
        workflows.insert(
            workflow_id.clone(),
            compile::validate_workflow(&path, &workflow_id, parsed.workflow)?,
        );
    }

    Ok(ValidatedWorkspace { project_root, rigg_dir, sources, workflows })
}
