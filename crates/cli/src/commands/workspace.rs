use miette::Result;
use rigg_config::ValidatedWorkspace;
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) fn discover_project_root(start: &Path) -> Result<&Path> {
    let start = if start.is_dir() { start } else { start.parent().unwrap_or(start) };
    start
        .ancestors()
        .find(|candidate| candidate.join(".rigg").is_dir())
        .ok_or_else(|| miette::miette!("no `.rigg` directory found from `{}`", start.display()))
}

pub(super) fn config_hash(workspace: &ValidatedWorkspace) -> String {
    let mut hasher = Sha256::new();
    for source in &workspace.sources {
        hasher.update(source.path.display().to_string().as_bytes());
        hasher.update(source.contents.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::discover_project_root;
    use miette::Result;
    use std::fs;

    #[test]
    fn discovers_project_root_from_rigg_directory_without_configs()
    -> Result<(), Box<dyn std::error::Error>> {
        let suffix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_nanos();
        let project_root = std::env::temp_dir().join(format!("rigg-cli-{suffix}"));
        let nested = project_root.join("apps").join("api");
        fs::create_dir_all(project_root.join(".rigg").join("runs"))?;
        fs::create_dir_all(&nested)?;

        assert_eq!(discover_project_root(&nested)?, project_root.as_path());
        Ok(())
    }
}
