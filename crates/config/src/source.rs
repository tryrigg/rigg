use crate::loader::ConfigError;
use crate::syntax::ConfigDiscovery;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSource {
    pub path: PathBuf,
    pub contents: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedWorkspace {
    pub project_root: PathBuf,
    pub rigg_dir: PathBuf,
    pub sources: Vec<ConfigSource>,
}

impl LoadedWorkspace {
    pub fn discover(start: impl AsRef<Path>) -> Result<ConfigDiscovery, ConfigError> {
        let start = start.as_ref();
        let start = if start.is_dir() {
            start.to_path_buf()
        } else {
            start.parent().unwrap_or(start).to_path_buf()
        };

        for candidate in start.ancestors() {
            let rigg_dir = candidate.join(".rigg");
            if !rigg_dir.is_dir() {
                continue;
            }

            let mut files = fs::read_dir(&rigg_dir)
                .map_err(|source| ConfigError::ReadFile { path: rigg_dir.clone(), source })?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "yaml"))
                .collect::<Vec<_>>();
            files.sort();

            if files.is_empty() {
                return Err(ConfigError::NotFound { start: start.clone() });
            }

            return Ok(ConfigDiscovery { project_root: candidate.to_path_buf(), rigg_dir, files });
        }

        Err(ConfigError::NotFound { start })
    }

    pub fn load(start: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let discovery = Self::discover(start)?;
        let sources = discovery
            .files
            .iter()
            .map(|path| {
                fs::read_to_string(path)
                    .map(|contents| ConfigSource { path: path.clone(), contents })
                    .map_err(|source| ConfigError::ReadFile { path: path.clone(), source })
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self { project_root: discovery.project_root, rigg_dir: discovery.rigg_dir, sources })
    }
}
