use clap::{Args, Parser, Subcommand};
use miette::{IntoDiagnostic, Result, WrapErr};
use rigg_config::ConfigLoader;
use rigg_core::{Engine, ExecutionPlan, FlowName, RunId, StepId, ValidatedFlowFile};
use rigg_runtime::{CliExecutor, SystemClock};
use rigg_store::{
    LogSelection, LogStream, RunSnapshot, StatusQuery, StoreReader, StoreWriter, snapshot_from_core,
};
use serde_json::{Map, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Parser)]
#[command(name = "rigg")]
#[command(about = "Local QA workflow runner")]
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
struct ValidateCommand {
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct RunCommand {
    flow: String,
    #[arg(long)]
    json: bool,
    #[arg(long = "input", value_name = "KEY=VALUE")]
    inputs: Vec<String>,
}

#[derive(Debug, Args)]
struct StatusCommand {
    run_id: Option<String>,
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct LogsCommand {
    run_id: String,
    #[arg(long)]
    step: Option<String>,
    #[arg(long)]
    stderr: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Init => init(),
        Command::Validate(command) => validate(command),
        Command::Run(command) => run(command),
        Command::Status(command) => status(command),
        Command::Logs(command) => logs(command),
    }
}

fn init() -> Result<()> {
    let cwd = std::env::current_dir().into_diagnostic()?;
    let rigg_dir = cwd.join(".rigg");
    fs::create_dir_all(&rigg_dir).into_diagnostic()?;

    write_if_missing(&rigg_dir.join("plan.yaml"), PLAN_TEMPLATE.trim_start())?;
    write_if_missing(
        &rigg_dir.join("review-uncommitted.yaml"),
        REVIEW_UNCOMMITTED_TEMPLATE.trim_start(),
    )?;
    write_if_missing(&rigg_dir.join("review-branch.yaml"), REVIEW_BRANCH_TEMPLATE.trim_start())?;
    write_if_missing(&rigg_dir.join("review-commit.yaml"), REVIEW_COMMIT_TEMPLATE.trim_start())?;
    ensure_gitignore(&cwd.join(".gitignore"), "/.rigg/runs/")?;

    println!("Initialized .rigg/ with example flows.");
    println!("Generated flows: plan, review-uncommitted, review-branch, review-commit.");
    println!("Examples:");
    println!("  rigg run plan --input requirements='...' --input output_path=plan.md");
    println!("  rigg run review-uncommitted");
    println!("  rigg run review-branch --input base_branch=main");
    println!("  rigg run review-commit --input commit_sha=HEAD~1");
    Ok(())
}

fn validate(command: ValidateCommand) -> Result<()> {
    let cwd = std::env::current_dir().into_diagnostic()?;
    let flow_file = ConfigLoader::load(&cwd).into_diagnostic()?;
    let flow_names = flow_file.flows.keys().map(ToString::to_string).collect::<Vec<_>>();

    if command.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true,
                "project_root": flow_file.project_root,
                "flows": flow_names,
                "config_files": flow_file.files.iter().map(|file| &file.path).collect::<Vec<_>>(),
            }))
            .into_diagnostic()?
        );
    } else {
        println!("Validated {} flow(s): {}", flow_names.len(), flow_names.join(", "));
    }

    Ok(())
}

fn run(command: RunCommand) -> Result<()> {
    let cwd = std::env::current_dir().into_diagnostic()?;
    let flow_file = ConfigLoader::load(&cwd).into_diagnostic()?;
    let flow_name = parse_flow_name(&command.flow)?;
    let flow = flow_file
        .flows
        .get(&flow_name)
        .cloned()
        .ok_or_else(|| miette::miette!("flow `{}` was not found", flow_name))?;
    let inputs = parse_inputs(&command.inputs)?;

    let plan = ExecutionPlan {
        project_root: flow_file.project_root.clone(),
        config_files: flow_file.files.iter().map(|file| file.path.clone()).collect(),
        config_hash: config_hash(&flow_file),
        flow,
        invocation_inputs: inputs,
        parent_env: std::env::vars().collect::<BTreeMap<_, _>>(),
        tool_version: env!("CARGO_PKG_VERSION").to_owned(),
    };

    let mut recorder = StoreWriter::new(&flow_file.project_root);
    let state = Engine
        .run_plan(plan, &CliExecutor::default(), &mut recorder, &SystemClock)
        .into_diagnostic()
        .wrap_err("rigg run failed")?;

    if command.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&snapshot_from_core(&state)).into_diagnostic()?
        );
    } else {
        println!("Run {} finished with status {:?}.", state.run_id, state.status);
        if let Some(reason) = state.reason {
            println!("Reason: {reason:?}");
        }
    }

    if matches!(state.status, rigg_core::RunStatus::Succeeded) {
        Ok(())
    } else {
        Err(miette::miette!("flow execution failed"))
    }
}

fn status(command: StatusCommand) -> Result<()> {
    let cwd = std::env::current_dir().into_diagnostic()?;
    let flow_file = ConfigLoader::load(&cwd).into_diagnostic()?;
    let reader = StoreReader::new(flow_file.project_root);
    let snapshots = reader
        .statuses(StatusQuery { run_id: command.run_id.as_deref().map(parse_run_id).transpose()? })
        .into_diagnostic()?;

    if command.json {
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

fn logs(command: LogsCommand) -> Result<()> {
    let cwd = std::env::current_dir().into_diagnostic()?;
    let flow_file = ConfigLoader::load(&cwd).into_diagnostic()?;
    let reader = StoreReader::new(flow_file.project_root);
    let output = reader
        .logs(
            &parse_run_id(&command.run_id)?,
            LogSelection {
                step_id: command.step.as_deref().map(parse_step_id).transpose()?,
                stream: if command.stderr { LogStream::Stderr } else { LogStream::Stdout },
            },
        )
        .into_diagnostic()?;
    print!("{output}");
    Ok(())
}

fn parse_run_id(value: &str) -> Result<RunId> {
    value.parse().map_err(|error| miette::miette!("invalid run id `{value}`: {error}"))
}

fn parse_flow_name(value: &str) -> Result<FlowName> {
    value.parse().map_err(|error| miette::miette!("invalid flow name `{value}`: {error}"))
}

fn parse_step_id(value: &str) -> Result<StepId> {
    value.parse().map_err(|error| miette::miette!("invalid step id `{value}`: {error}"))
}

fn parse_inputs(values: &[String]) -> Result<JsonValue> {
    let mut map = Map::new();
    for value in values {
        let Some((key, raw_value)) = value.split_once('=') else {
            return Err(miette::miette!("invalid --input `{value}`; expected KEY=VALUE"));
        };
        let parsed = serde_json::from_str(raw_value)
            .unwrap_or_else(|_| JsonValue::String(raw_value.to_owned()));
        map.insert(key.to_owned(), parsed);
    }
    Ok(JsonValue::Object(map))
}

fn config_hash(flow_file: &ValidatedFlowFile) -> String {
    let mut hasher = Sha256::new();
    for file in &flow_file.files {
        hasher.update(file.path.display().to_string().as_bytes());
        hasher.update(file.contents.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn write_if_missing(path: &Path, contents: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }

    fs::write(path, contents).into_diagnostic()?;
    Ok(())
}

fn ensure_gitignore(path: &Path, line: &str) -> Result<()> {
    let mut contents =
        if path.exists() { fs::read_to_string(path).into_diagnostic()? } else { String::new() };

    if !contents.lines().any(|existing| existing == line) {
        if !contents.is_empty() && !contents.ends_with('\n') {
            contents.push('\n');
        }
        contents.push_str(line);
        contents.push('\n');
        fs::write(path, contents).into_diagnostic()?;
    }
    Ok(())
}

fn print_snapshot(snapshot: &RunSnapshot) {
    println!(
        "{}  {}  {:?}  iteration {}/{}",
        snapshot.run_id,
        snapshot.flow_name,
        snapshot.status,
        snapshot.current_iteration,
        snapshot.max_iterations
    );
    for step in &snapshot.steps {
        println!("  {:<16} {:?} exit={:?}", step.step_id, step.status, step.exit_code);
    }
}

const PLAN_TEMPLATE: &str = r#"
flows:
  plan:
    inputs:
      requirements: string
      output_path: string
    steps:
      - id: draft
        type: claude
        with:
          action: prompt
          prompt: |
            Draft an implementation plan from the requirements below.
            
            Requirements:
            ${{ inputs.requirements }}
            
            Return JSON with a single `markdown` field.
        outputs:
          markdown: string

      - id: improve
        type: codex
        with:
          action: exec
          prompt: |
            Refine the plan below.
            Make it concrete and implementation-ready.
            
            Draft:
            ${{ steps.draft.outputs.markdown }}
        outputs:
          markdown: string

      - id: write
        type: write_file
        with:
          path: ${{ inputs.output_path }}
          content: ${{ steps.improve.outputs.markdown }}
        outputs:
          path: string
"#;

const REVIEW_UNCOMMITTED_TEMPLATE: &str = r#"
flows:
  review-uncommitted:
    steps:
      - id: review
        type: codex
        with:
          action: review
          target: uncommitted
          prompt: Review current uncommitted changes for bugs and missing tests.
        outputs:
          review: string

      - id: judge
        type: claude
        with:
          action: prompt
          prompt: |
            Read the review below.
            
            Review:
            ${{ steps.review.outputs.review }}
            
            Accept only findings that are valid and actionable.
        outputs:
          accepted_count: integer
          fix_brief: string

      - id: fix
        if: ${{ steps.judge.outputs.accepted_count > 0 }}
        type: codex
        with:
          action: exec
          mode: full_auto
          prompt: ${{ steps.judge.outputs.fix_brief }}

    loop:
      until: ${{ steps.judge.outputs.accepted_count == 0 }}
      max: 5
"#;

const REVIEW_BRANCH_TEMPLATE: &str = r#"
flows:
  review-branch:
    inputs:
      base_branch: string
    steps:
      - id: review
        type: codex
        with:
          action: review
          target: base
          base: ${{ inputs.base_branch }}
          prompt: Review the current branch diff for bugs and missing tests.
        outputs:
          review: string

      - id: judge
        type: claude
        with:
          action: prompt
          prompt: |
            Read the review below.
            
            Review:
            ${{ steps.review.outputs.review }}
            
            Accept only findings that are valid and actionable.
        outputs:
          accepted_count: integer
          fix_brief: string

      - id: fix
        if: ${{ steps.judge.outputs.accepted_count > 0 }}
        type: codex
        with:
          action: exec
          mode: full_auto
          prompt: ${{ steps.judge.outputs.fix_brief }}

    loop:
      until: ${{ steps.judge.outputs.accepted_count == 0 }}
      max: 5
"#;

const REVIEW_COMMIT_TEMPLATE: &str = r#"
flows:
  review-commit:
    inputs:
      commit_sha: string
    steps:
      - id: review
        type: codex
        with:
          action: review
          target: commit
          commit: ${{ inputs.commit_sha }}
          title: Review commit
          prompt: Review the selected commit for bugs and missing tests.
        outputs:
          review: string

      - id: judge
        type: claude
        with:
          action: prompt
          prompt: |
            Read the review below.
            
            Review:
            ${{ steps.review.outputs.review }}
            
            Accept only findings that are valid and actionable.
        outputs:
          accepted_count: integer
          fix_brief: string

      - id: fix
        if: ${{ steps.judge.outputs.accepted_count > 0 }}
        type: codex
        with:
          action: exec
          mode: full_auto
          prompt: ${{ steps.judge.outputs.fix_brief }}

    loop:
      until: ${{ steps.judge.outputs.accepted_count == 0 }}
      max: 5
"#;

#[cfg(test)]
mod tests {
    use super::{parse_run_id, parse_step_id};
    use miette::Result;

    #[test]
    fn parses_valid_run_id() -> Result<()> {
        let run_id = parse_run_id("019cc300-0000-7000-8000-000000000010")?;
        assert_eq!(run_id.to_string(), "019cc300-0000-7000-8000-000000000010");
        Ok(())
    }

    #[test]
    fn rejects_invalid_step_id() {
        let error = match parse_step_id("1 invalid") {
            Ok(step_id) => panic!("expected invalid step id, got {step_id}"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("invalid step id"));
    }
}
