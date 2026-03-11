use super::ValidateCommand;
use miette::{IntoDiagnostic, Result};
use rigg_config::load_workspace;

pub(super) fn run(command: ValidateCommand) -> Result<()> {
    let cwd = std::env::current_dir().into_diagnostic()?;
    let workflow_set = load_workspace(&cwd).into_diagnostic()?;
    let workflow_ids = workflow_set.workflows.keys().map(ToString::to_string).collect::<Vec<_>>();

    if command.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "project_root": workflow_set.project_root,
                "workflows": workflow_ids,
                "config_files": workflow_set
                    .sources
                    .iter()
                    .map(|file| &file.path)
                    .collect::<Vec<_>>(),
            }))
            .into_diagnostic()?
        );
    } else {
        println!("Validated {} workflow(s): {}", workflow_ids.len(), workflow_ids.join(", "));
    }

    Ok(())
}
