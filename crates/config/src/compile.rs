use crate::loader;
use crate::loader::ConfigError;
use crate::source::{ConfigSource, LoadedWorkspace};
use rigg_core::{ValidatedWorkflow, WorkflowId};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedWorkspace {
    pub project_root: std::path::PathBuf,
    pub rigg_dir: std::path::PathBuf,
    pub sources: Vec<ConfigSource>,
    pub workflows: BTreeMap<WorkflowId, ValidatedWorkflow>,
}

pub fn compile_workspace(workspace: LoadedWorkspace) -> Result<ValidatedWorkspace, ConfigError> {
    loader::compile_workspace(workspace)
}

pub fn load_workspace(start: impl AsRef<Path>) -> Result<ValidatedWorkspace, ConfigError> {
    compile_workspace(LoadedWorkspace::load(start)?)
}
