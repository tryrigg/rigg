use rigg_core::{EvalError, InputValueType, OutputType, RunReason, TemplateError};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error(transparent)]
    Validation(#[from] ValidationError),
    #[error(transparent)]
    Evaluation(#[from] EvaluationError),
    #[error(transparent)]
    Render(#[from] RenderError),
    #[error(transparent)]
    Result(#[from] ResultError),
    #[error(transparent)]
    Executor(#[from] ExecutorError),
    #[error(transparent)]
    Recorder(#[from] RecorderError),
}

#[derive(Debug, Error)]
pub enum ValidationError {
    #[error("workflow inputs must be a JSON object")]
    ExpectedObject,
    #[error("unexpected workflow input `{input}`")]
    UnexpectedInput { input: String },
    #[error("missing required workflow input `{input}`")]
    MissingInput { input: String },
    #[error("workflow input `{path}` is required")]
    MissingRequiredField { path: String },
    #[error("workflow input `{path}` must be `{expected}`")]
    TypeMismatch { path: String, expected: InputValueType },
    #[error("workflow input `{path}` must be one of the declared enum values")]
    EnumViolation { path: String },
    #[error("workflow input `{path}` must be {constraint} {limit}")]
    RangeViolation { path: String, constraint: &'static str, limit: String },
    #[error("workflow input `{path}` must have {constraint} {limit}")]
    LengthViolation { path: String, constraint: &'static str, limit: usize },
    #[error("workflow input `{path}` must match pattern `{pattern}`")]
    PatternViolation { path: String, pattern: String },
    #[error("workflow input `{path}` must contain {constraint} {limit} item(s)")]
    ItemCountViolation { path: String, constraint: &'static str, limit: usize },
}

#[derive(Debug, Error)]
pub enum EvaluationError {
    #[error("failed to evaluate expression")]
    Expr {
        #[source]
        source: EvalError,
    },
}

#[derive(Debug, Error)]
pub enum RenderError {
    #[error("failed to render template")]
    Template {
        #[source]
        source: TemplateError,
    },
    #[error("failed to resolve the current working directory")]
    CurrentDirectory {
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Error)]
pub enum ResultError {
    #[error("structured result for `{node}` was not produced")]
    MissingStructuredResult { node: String },
    #[error("result for `{node}` is missing required field `{field}`")]
    MissingRequiredField { node: String, field: String },
    #[error("result field `{output}` for `{node}` did not match declared type `{expected}`")]
    ResultTypeMismatch { node: String, output: String, expected: OutputType },
}

#[derive(Debug, Error)]
pub enum ExecutorError {
    #[error("failed to spawn `/bin/sh -lc`")]
    SpawnShell {
        #[source]
        source: std::io::Error,
    },
    #[error("failed to write structured output schema `{path}`")]
    WriteSchema {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to run `{program}`")]
    RunTool {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error(
        "`{program}` exceeded the hard timeout of {timeout_ms}ms and was terminated after {grace_period_ms}ms grace"
    )]
    StepTimedOut { program: String, timeout_ms: u128, grace_period_ms: u128 },
    #[error("failed to create directory `{path}`")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to write `{path}`")]
    WriteFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to read `{path}`")]
    ReadFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to serialize JSON for `{operation}`")]
    SerializeJson {
        operation: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("failed to parse JSON output from `{tool}`")]
    ParseJsonOutput {
        tool: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("`codex exec resume` does not support `{option}`")]
    UnsupportedCodexResumeOption { option: &'static str },
    #[error("`{tool}` did not return a conversation handle for a persisted conversation node")]
    MissingConversationHandle { tool: &'static str },
    #[error("{source}")]
    StepPostProcess {
        execution: Box<crate::StepRunResult>,
        #[source]
        source: Box<ExecutorError>,
    },
    #[error(
        "parallel branches updated conversation `{name}` in `{scope}` scope with conflicting handles"
    )]
    ParallelConversationConflict { name: String, scope: String },
    #[error(
        "loop node `{node}` exhausted after {max_iterations} iterations without satisfying `until`"
    )]
    LoopExhausted { node: String, max_iterations: u32 },
}

impl ExecutorError {
    pub fn with_partial_execution(self, execution: crate::StepRunResult) -> Self {
        Self::StepPostProcess { execution: Box::new(execution), source: Box::new(self) }
    }

    pub fn partial_execution(&self) -> Option<&crate::StepRunResult> {
        match self {
            Self::StepPostProcess { execution, .. } => Some(execution.as_ref()),
            _ => None,
        }
    }

    pub(super) fn run_reason(&self) -> RunReason {
        match self {
            Self::ParseJsonOutput { .. } => RunReason::StepFailed,
            Self::UnsupportedCodexResumeOption { .. } => RunReason::StepFailed,
            Self::MissingConversationHandle { .. } => RunReason::StepFailed,
            Self::StepPostProcess { source, .. } => source.run_reason(),
            Self::ParallelConversationConflict { .. } => RunReason::StepFailed,
            Self::LoopExhausted { .. } => RunReason::StepFailed,
            Self::StepTimedOut { .. } => RunReason::StepTimedOut,
            Self::SpawnShell { .. }
            | Self::WriteSchema { .. }
            | Self::RunTool { .. }
            | Self::CreateDirectory { .. }
            | Self::WriteFile { .. }
            | Self::ReadFile { .. }
            | Self::SerializeJson { .. } => RunReason::EngineError,
        }
    }
}

impl EngineError {
    pub fn with_partial_execution(self, execution: crate::StepRunResult) -> Self {
        match self {
            Self::Executor(error) => Self::Executor(error.with_partial_execution(execution)),
            other => other,
        }
    }

    pub fn partial_execution(&self) -> Option<&crate::StepRunResult> {
        match self {
            Self::Executor(error) => error.partial_execution(),
            _ => None,
        }
    }
}

#[derive(Debug, Error)]
pub enum RecorderError {
    #[error("run directory is not initialized")]
    RunDirectoryNotInitialized,
    #[error("events path is not initialized")]
    EventsPathNotInitialized,
    #[error("buffered parallel log path `{path}` was not registered")]
    BufferedLogPathNotRegistered { path: String },
    #[error("failed to create directory `{path}`")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to write `{path}`")]
    WriteFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open `{path}`")]
    OpenFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to append `{path}`")]
    AppendFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to replace `{to}` with `{from}`")]
    ReplaceFile {
        from: PathBuf,
        to: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to serialize JSON for `{operation}`")]
    SerializeJson {
        operation: &'static str,
        #[source]
        source: serde_json::Error,
    },
}

pub(super) fn eval_error(error: EvalError) -> EngineError {
    EvaluationError::Expr { source: error }.into()
}

pub(super) fn template_error(error: TemplateError) -> EngineError {
    RenderError::Template { source: error }.into()
}

pub(super) fn current_dir_error(error: std::io::Error) -> EngineError {
    RenderError::CurrentDirectory { source: error }.into()
}

#[cfg(test)]
mod tests {
    use super::ExecutorError;

    #[test]
    fn timeout_executor_errors_map_to_timeout_run_reasons() {
        assert_eq!(
            ExecutorError::StepTimedOut {
                program: "codex".to_owned(),
                timeout_ms: 100,
                grace_period_ms: 10,
            }
            .run_reason(),
            crate::RunReason::StepTimedOut
        );
    }
}
