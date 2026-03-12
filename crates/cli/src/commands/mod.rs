mod init;
mod input;
mod logs;
mod run;
mod status;
mod validate;
mod workspace;

use clap::{Args, Parser, Subcommand};
use miette::Result;

#[derive(Debug, Parser)]
#[command(name = "rigg")]
#[command(about = "Local QA workflow runner")]
#[command(version = env!("CARGO_PKG_VERSION"))]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Init,
    Validate(ValidateCommand),
    Run(RunCommand),
    Status(StatusCommand),
    Logs(LogsCommand),
}

#[derive(Debug, Args)]
pub(super) struct ValidateCommand {
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
pub(super) struct RunCommand {
    workflow_id: String,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    quiet: bool,
    #[arg(long = "input", value_name = "KEY=VALUE")]
    inputs: Vec<String>,
}

#[derive(Debug, Args)]
pub(super) struct StatusCommand {
    run_id: Option<String>,
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
pub(super) struct LogsCommand {
    run_id: String,
    #[arg(long)]
    node: Option<String>,
    #[arg(long)]
    stderr: bool,
}

pub(crate) fn run() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Init => init::run(),
        Command::Validate(command) => validate::run(command),
        Command::Run(command) => run::run(command),
        Command::Status(command) => status::run(command),
        Command::Logs(command) => logs::run(command),
    }
}
