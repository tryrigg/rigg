use super::StatusCommand;
use super::input::parse_run_id;
use super::workspace::discover_project_root;
use miette::{IntoDiagnostic, Result};
use rigg_core::RunId;
use rigg_store::{RunSnapshot, RunStore, StatusQuery};

pub(super) fn run(command: StatusCommand) -> Result<()> {
    let request = StatusCommandRequest::try_from(command)?;
    let cwd = std::env::current_dir().into_diagnostic()?;
    let reader = RunStore::new(discover_project_root(&cwd)?);
    let snapshots = reader.statuses(StatusQuery { run_id: request.run_id }).into_diagnostic()?;

    if matches!(request.format, StatusOutput::Json) {
        println!("{}", serde_json::to_string_pretty(&snapshots).into_diagnostic()?);
        return Ok(());
    }

    if snapshots.is_empty() {
        println!("No runs found.");
        return Ok(());
    }

    for snapshot in snapshots {
        print_snapshot(&snapshot);
    }

    Ok(())
}

fn print_snapshot(snapshot: &RunSnapshot) {
    println!("{}  {}  {:?}", snapshot.run_id, snapshot.workflow_id, snapshot.status);
    for node in &snapshot.nodes {
        let label = node.user_id.as_deref().unwrap_or(&node.node_path);
        println!("  {:<16} {:?} exit={:?}", label, node.status, node.exit_code);
    }
}

struct StatusCommandRequest {
    run_id: Option<RunId>,
    format: StatusOutput,
}

impl TryFrom<StatusCommand> for StatusCommandRequest {
    type Error = miette::Report;

    fn try_from(command: StatusCommand) -> Result<Self, Self::Error> {
        Ok(Self {
            run_id: command.run_id.as_deref().map(parse_run_id).transpose()?,
            format: StatusOutput::from_json_flag(command.json),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatusOutput {
    Text,
    Json,
}

impl StatusOutput {
    fn from_json_flag(json: bool) -> Self {
        if json { Self::Json } else { Self::Text }
    }
}
