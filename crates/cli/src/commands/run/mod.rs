mod format;
mod progress;

use super::RunCommand;
use super::input::{parse_inputs, parse_workflow_id};
use super::workspace::config_hash;
use miette::{IntoDiagnostic, Result, WrapErr};
use progress::TerminalProgressSink;
use rigg_config::load_workspace;
use rigg_core::{RunState, RunStatus, WorkflowId};
use rigg_engine::{Engine, EngineError, ExecutionPlan};
use rigg_runtime::{DefaultStepRunner, SystemClock};
use rigg_store::{FsRunRecorder, RunSnapshot};
use std::collections::BTreeMap;
use std::io::IsTerminal;

pub(super) fn run(command: RunCommand) -> Result<()> {
    let request = RunCommandRequest::try_from(command)?;
    let cwd = std::env::current_dir().into_diagnostic()?;
    let workflow_set = load_workspace(&cwd).into_diagnostic()?;
    let workflow = workflow_set
        .workflows
        .get(&request.workflow_id)
        .cloned()
        .ok_or_else(|| miette::miette!("workflow `{}` was not found", request.workflow_id))?;

    let plan = ExecutionPlan {
        project_root: workflow_set.project_root.clone(),
        config_files: workflow_set.sources.iter().map(|file| file.path.clone()).collect(),
        config_hash: config_hash(&workflow_set),
        workflow,
        invocation_inputs: request.inputs,
        parent_env: std::env::vars().collect::<BTreeMap<_, _>>(),
        tool_version: env!("CARGO_PKG_VERSION").to_owned(),
    };

    let mut recorder = FsRunRecorder::new(&workflow_set.project_root);
    let state = run_workflow(plan, &mut recorder, request.progress)
        .into_diagnostic()
        .wrap_err("rigg run failed")?;

    request.summary.write(&state)?;

    if matches!(state.status, RunStatus::Succeeded) {
        Ok(())
    } else {
        Err(miette::miette!("workflow execution failed"))
    }
}

fn run_workflow(
    plan: ExecutionPlan,
    recorder: &mut FsRunRecorder,
    progress: ProgressMode,
) -> Result<RunState, EngineError> {
    let step_runner = DefaultStepRunner::default();

    match progress {
        ProgressMode::Quiet => Engine.run_plan(plan, &step_runner, recorder, &SystemClock),
        ProgressMode::Live => {
            let mut progress = TerminalProgressSink::new(std::io::stderr());
            Engine.run_plan_with_progress(plan, &step_runner, recorder, &SystemClock, &mut progress)
        }
    }
}

struct RunCommandRequest {
    workflow_id: WorkflowId,
    inputs: serde_json::Value,
    summary: SummaryFormat,
    progress: ProgressMode,
}

impl TryFrom<RunCommand> for RunCommandRequest {
    type Error = miette::Report;

    fn try_from(command: RunCommand) -> Result<Self, Self::Error> {
        Ok(Self {
            workflow_id: parse_workflow_id(&command.workflow_id)?,
            inputs: parse_inputs(&command.inputs)?,
            summary: SummaryFormat::from_json_flag(command.json),
            progress: ProgressMode::resolve(
                command.quiet,
                command.json,
                std::io::stderr().is_terminal(),
            ),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SummaryFormat {
    Text,
    Json,
}

impl SummaryFormat {
    fn from_json_flag(json: bool) -> Self {
        if json { Self::Json } else { Self::Text }
    }

    fn write(self, state: &RunState) -> Result<()> {
        match self {
            Self::Json => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&RunSnapshot::from(state)).into_diagnostic()?
                );
            }
            Self::Text => {
                println!("Run {} finished with status {:?}.", state.run_id, state.status);
                if let Some(reason) = state.reason {
                    println!("Reason: {reason:?}");
                }
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProgressMode {
    Quiet,
    Live,
}

impl ProgressMode {
    fn resolve(quiet: bool, json: bool, stderr_is_terminal: bool) -> Self {
        if quiet || json || !stderr_is_terminal { Self::Quiet } else { Self::Live }
    }
}

#[cfg(test)]
mod tests {
    use super::ProgressMode;

    fn check(quiet: bool, json: bool, is_terminal: bool, expected: ProgressMode) {
        assert_eq!(ProgressMode::resolve(quiet, json, is_terminal), expected);
    }

    #[test]
    fn enables_live_progress_for_interactive_text_runs() {
        check(false, false, true, ProgressMode::Live);
    }

    #[test]
    fn disables_progress_for_json_runs() {
        check(false, true, true, ProgressMode::Quiet);
    }

    #[test]
    fn disables_progress_for_non_interactive_runs() {
        check(false, false, false, ProgressMode::Quiet);
    }

    #[test]
    fn disables_progress_when_quiet_is_requested() {
        check(true, false, true, ProgressMode::Quiet);
    }
}
