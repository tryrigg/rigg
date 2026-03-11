use super::LogsCommand;
use super::input::parse_run_id;
use super::workspace::discover_project_root;
use miette::{IntoDiagnostic, Result};
use rigg_core::RunId;
use rigg_store::{LogSelection, LogStream, RunStore};

pub(super) fn run(command: LogsCommand) -> Result<()> {
    let request = LogsCommandRequest::try_from(command)?;
    let cwd = std::env::current_dir().into_diagnostic()?;
    let reader = RunStore::new(discover_project_root(&cwd)?);
    let output = reader
        .logs(&request.run_id, LogSelection { node: request.node, stream: request.stream })
        .into_diagnostic()?;
    print!("{output}");
    Ok(())
}

struct LogsCommandRequest {
    run_id: RunId,
    node: Option<String>,
    stream: LogStream,
}

impl TryFrom<LogsCommand> for LogsCommandRequest {
    type Error = miette::Report;

    fn try_from(command: LogsCommand) -> Result<Self, Self::Error> {
        Ok(Self {
            run_id: parse_run_id(&command.run_id)?,
            node: command.node,
            stream: if command.stderr { LogStream::Stderr } else { LogStream::Stdout },
        })
    }
}
