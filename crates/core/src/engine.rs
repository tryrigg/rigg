use crate::event::{
    RunEvent, RunEventRecord, RunMeta, RunReason, RunStatus, StepEvent, StepStatus, StreamKind,
};
use crate::expr::{EvalError, EvalOutcome, TemplateError, context as expr_context};
use crate::flow::{
    ClaudePermissionMode, CodexAction, CodexMode, OutputType, ReviewScope, ShellResultMode,
    StepKind, ValidatedFlow, ValidatedStep,
};
use crate::ids::{RunId, StepId};
use crate::state::{CapturedValue, RunState, StepResult};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::BTreeMap;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct ExecutionPlan {
    pub project_root: PathBuf,
    pub config_files: Vec<PathBuf>,
    pub config_hash: String,
    pub flow: ValidatedFlow,
    pub invocation_inputs: JsonValue,
    pub parent_env: BTreeMap<String, String>,
    pub tool_version: String,
}

pub trait Clock {
    fn now(&self) -> String;
}

#[derive(Debug, Clone)]
pub enum ExecutionRequest {
    Codex(RenderedCodexRequest),
    Claude(RenderedClaudeRequest),
    Shell(RenderedShellRequest),
    WriteFile(RenderedWriteFileRequest),
}

impl ExecutionRequest {
    pub fn label(&self) -> String {
        match self {
            Self::Codex(request) => request.label(),
            Self::Claude(_) => "claude".to_owned(),
            Self::Shell(request) => request.command.clone(),
            Self::WriteFile(request) => format!("write_file {}", request.path.display()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RenderedCodexRequest {
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub result_schema: Option<JsonValue>,
    pub action: RenderedCodexAction,
}

impl RenderedCodexRequest {
    fn label(&self) -> String {
        match &self.action {
            RenderedCodexAction::Review { prompt, .. } => {
                format!("codex review {}", prompt.as_deref().map(preview).unwrap_or_default())
            }
            RenderedCodexAction::Exec { prompt, .. } => format!("codex exec {}", preview(prompt)),
        }
    }
}

#[derive(Debug, Clone)]
pub enum RenderedCodexAction {
    Review {
        prompt: Option<String>,
        model: Option<String>,
        mode: CodexMode,
        title: Option<String>,
        add_dirs: Vec<String>,
        persist: bool,
        scope: RenderedReviewScope,
    },
    Exec {
        prompt: String,
        model: Option<String>,
        mode: CodexMode,
        add_dirs: Vec<String>,
        persist: bool,
    },
}

#[derive(Debug, Clone)]
pub enum RenderedReviewScope {
    Uncommitted,
    Base(String),
    Commit(String),
}

#[derive(Debug, Clone)]
pub struct RenderedClaudeRequest {
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub prompt: String,
    pub model: Option<String>,
    pub permission_mode: ClaudePermissionMode,
    pub add_dirs: Vec<String>,
    pub persist: bool,
    pub result_schema: Option<JsonValue>,
}

#[derive(Debug, Clone)]
pub struct RenderedShellRequest {
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub command: String,
    pub result_mode: ShellResultMode,
}

#[derive(Debug, Clone)]
pub struct RenderedWriteFileRequest {
    pub cwd: PathBuf,
    pub path: PathBuf,
    pub contents: String,
}

#[derive(Debug, Clone)]
pub struct StepExecution {
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u128,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub result: Option<CapturedValue>,
}

pub trait StepExecutor {
    fn execute(&self, request: &ExecutionRequest) -> Result<StepExecution, EngineError>;
}

pub trait Recorder {
    fn write_meta(&mut self, meta: &RunMeta) -> Result<(), EngineError>;
    fn append_event(&mut self, event: &RunEventRecord) -> Result<(), EngineError>;
    fn write_state(&mut self, state: &RunState) -> Result<(), EngineError>;
    fn log_path(&self, step: &ValidatedStep, attempt: u32, stream: StreamKind) -> String;
    fn append_log(&mut self, path: &str, chunk: &str) -> Result<(), EngineError>;
}

#[derive(Debug, Default)]
pub struct Engine;

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
    #[error("flow inputs must be a JSON object")]
    ExpectedObject,
    #[error("unexpected flow input `{input}`")]
    UnexpectedInput { input: String },
    #[error("missing required flow input `{input}`")]
    MissingInput { input: String },
    #[error("flow input `{key}` did not match declared type `{expected}`")]
    TypeMismatch { key: String, expected: OutputType },
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
}

#[derive(Debug, Error)]
pub enum ResultError {
    #[error("declared outputs require a step result for `{step_id}`")]
    MissingStepResult { step_id: StepId },
    #[error("multiple outputs require object result for `{step_id}`")]
    ExpectedObjectResult { step_id: StepId },
    #[error("result for `{step_id}` is missing output `{output}`")]
    MissingOutput { step_id: StepId, output: String },
    #[error("output `{output}` for `{step_id}` did not match declared type `{expected}`")]
    OutputTypeMismatch { step_id: StepId, output: String, expected: OutputType },
    #[error("internal result schema is missing properties for `{step_id}`")]
    MissingSchemaProperties { step_id: StepId },
    #[error("expected object result for `{step_id}`")]
    ExpectedStructuredResult { step_id: StepId },
    #[error("invalid required field in internal schema for `{step_id}`")]
    InvalidRequiredField { step_id: StepId },
    #[error("result for `{step_id}` is missing required field `{field}`")]
    MissingRequiredField { step_id: StepId, field: String },
    #[error("unsupported internal schema type `{schema_type}` for `{step_id}`")]
    UnsupportedSchemaType { step_id: StepId, schema_type: String },
    #[error("internal schema is missing `type` for `{step_id}`")]
    MissingSchemaType { step_id: StepId },
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
}

#[derive(Debug, Error)]
pub enum RecorderError {
    #[error("run directory is not initialized")]
    RunDirectoryNotInitialized,
    #[error("events path is not initialized")]
    EventsPathNotInitialized,
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

impl Engine {
    pub fn run_plan(
        &self,
        plan: ExecutionPlan,
        executor: &dyn StepExecutor,
        recorder: &mut dyn Recorder,
        clock: &dyn Clock,
    ) -> Result<RunState, EngineError> {
        validate_invocation_inputs(&plan.flow, &plan.invocation_inputs)?;
        let run_id = RunId::new();
        let started_at = clock.now();
        let max_iterations = plan.flow.r#loop.as_ref().map_or(1, |loop_config| loop_config.max);
        let mut state = RunState {
            run_id: run_id.clone(),
            flow_name: plan.flow.name.clone(),
            status: RunStatus::Running,
            reason: None,
            current_iteration: 0,
            max_iterations,
            started_at: started_at.clone(),
            finished_at: None,
            steps: plan
                .flow
                .steps
                .iter()
                .map(|step| StepResult {
                    step_id: step.id.clone(),
                    index: step.index,
                    attempt: 0,
                    status: StepStatus::Pending,
                    started_at: None,
                    finished_at: None,
                    duration_ms: None,
                    exit_code: None,
                    stdout_path: None,
                    stderr_path: None,
                    stdout_preview: String::new(),
                    stderr_preview: String::new(),
                    stdout: None,
                    stderr: None,
                    result: None,
                    outputs: JsonMap::new(),
                })
                .collect(),
        };

        recorder.write_meta(&RunMeta {
            run_id: run_id.clone(),
            flow_name: plan.flow.name.clone(),
            cwd: plan.project_root.clone(),
            started_at: started_at.clone(),
            tool_version: plan.tool_version.clone(),
            config_hash: plan.config_hash.clone(),
            config_files: plan.config_files.clone(),
            invocation_inputs: plan.invocation_inputs.clone(),
        })?;

        recorder.append_event(&RunEventRecord {
            ts: started_at,
            event: RunEvent::RunStarted {
                run_id,
                flow_name: plan.flow.name.clone(),
                cwd: plan.project_root.clone(),
                max_iterations,
            },
        })?;
        recorder.write_state(&state)?;

        for iteration in 1..=max_iterations {
            state.current_iteration = iteration;
            recorder.append_event(&RunEventRecord {
                ts: clock.now(),
                event: RunEvent::IterationStarted { iteration },
            })?;
            recorder.write_state(&state)?;

            for step in &plan.flow.steps {
                let step_env = render_env(&plan, &state, &step.env)?;
                let context = build_context(&plan, &state, &step_env);

                if let Some(condition) = &step.if_expr {
                    match condition.evaluate(&context).map_err(eval_error)? {
                        EvalOutcome::Bool(true) => {}
                        EvalOutcome::Bool(false) => {
                            mark_skipped(&mut state.steps[step.index], clock);
                            recorder.append_event(&RunEventRecord {
                                ts: clock.now(),
                                event: RunEvent::StepSkipped {
                                    iteration,
                                    step_id: step.id.clone(),
                                    reason: "condition evaluated to false".to_owned(),
                                },
                            })?;
                            recorder.write_state(&state)?;
                            continue;
                        }
                        _ => unreachable!("boolean expressions always return bool"),
                    }
                }

                let request = render_request(&plan, step, &step_env, &context)?;

                let attempt = state.steps[step.index].attempt + 1;
                recorder.append_event(&RunEventRecord {
                    ts: clock.now(),
                    event: RunEvent::StepStarted {
                        iteration,
                        step_id: step.id.clone(),
                        attempt,
                        command: request.label(),
                    },
                })?;

                let execution = executor.execute(&request)?;
                let stdout_path = recorder.log_path(step, attempt, StreamKind::Stdout);
                let stderr_path = recorder.log_path(step, attempt, StreamKind::Stderr);
                recorder.append_log(&stdout_path, &execution.stdout)?;
                recorder.append_log(&stderr_path, &execution.stderr)?;

                let result = finalize_result(step, execution.result.as_ref())?;
                let outputs = extract_outputs(step, result.as_ref())?;
                let execution_status = if execution.exit_code == 0 {
                    StepStatus::Succeeded
                } else {
                    StepStatus::Failed
                };

                let step_state = &mut state.steps[step.index];
                step_state.attempt = attempt;
                step_state.status = execution_status;
                step_state.started_at = Some(execution.started_at.clone());
                step_state.finished_at = Some(execution.finished_at.clone());
                step_state.duration_ms = Some(execution.duration_ms);
                step_state.exit_code = Some(execution.exit_code);
                step_state.stdout_path = Some(stdout_path);
                step_state.stderr_path = Some(stderr_path);
                step_state.stdout_preview = preview(&execution.stdout);
                step_state.stderr_preview = preview(&execution.stderr);
                step_state.stdout = Some(CapturedValue::Text(execution.stdout.clone()));
                step_state.stderr = Some(execution.stderr.clone());
                step_state.result = result.clone();
                step_state.outputs = outputs.clone();

                recorder.append_event(&RunEventRecord {
                    ts: clock.now(),
                    event: RunEvent::StepFinished(Box::new(StepEvent {
                        iteration,
                        step_id: step.id.clone(),
                        attempt,
                        exit_code: step_state.exit_code,
                        status: step_state.status,
                        stdout_path: step_state.stdout_path.clone(),
                        stderr_path: step_state.stderr_path.clone(),
                        stdout_preview: step_state.stdout_preview.clone(),
                        stderr_preview: step_state.stderr_preview.clone(),
                        stdout: step_state.stdout.clone(),
                        stderr: step_state.stderr.clone(),
                        result: step_state.result.clone(),
                        outputs: step_state.outputs.clone(),
                    })),
                })?;
                recorder.write_state(&state)?;

                if execution.exit_code != 0 {
                    return self.finish_run(
                        state,
                        recorder,
                        RunStatus::Failed,
                        RunReason::StepFailed,
                        clock,
                    );
                }
            }

            let Some(loop_config) = &plan.flow.r#loop else {
                return self.finish_run(
                    state,
                    recorder,
                    RunStatus::Succeeded,
                    RunReason::Completed,
                    clock,
                );
            };

            let loop_env = render_env(&plan, &state, &[])?;
            let loop_context = build_context(&plan, &state, &loop_env);
            let loop_result = match loop_config.until.evaluate(&loop_context).map_err(eval_error)? {
                EvalOutcome::Bool(result) => result,
                _ => unreachable!("boolean expressions always return bool"),
            };

            recorder.append_event(&RunEventRecord {
                ts: clock.now(),
                event: RunEvent::LoopEvaluated { iteration, result: loop_result },
            })?;
            recorder.write_state(&state)?;

            if loop_result {
                return self.finish_run(
                    state,
                    recorder,
                    RunStatus::Succeeded,
                    RunReason::Completed,
                    clock,
                );
            }
        }

        self.finish_run(state, recorder, RunStatus::Failed, RunReason::LoopMaxExhausted, clock)
    }

    fn finish_run(
        &self,
        mut state: RunState,
        recorder: &mut dyn Recorder,
        status: RunStatus,
        reason: RunReason,
        clock: &dyn Clock,
    ) -> Result<RunState, EngineError> {
        state.status = status;
        state.reason = Some(reason);
        state.finished_at = Some(clock.now());
        recorder.append_event(&RunEventRecord {
            ts: clock.now(),
            event: RunEvent::RunFinished { status, reason },
        })?;
        recorder.write_state(&state)?;
        Ok(state)
    }
}

fn render_request(
    plan: &ExecutionPlan,
    step: &ValidatedStep,
    step_env: &BTreeMap<String, String>,
    context: &JsonValue,
) -> Result<ExecutionRequest, EngineError> {
    match &step.kind {
        StepKind::Shell(shell) => Ok(ExecutionRequest::Shell(RenderedShellRequest {
            cwd: plan.project_root.clone(),
            env: step_env.clone(),
            command: shell.command.render(context).map_err(template_error)?,
            result_mode: shell.result_mode,
        })),
        StepKind::WriteFile(write) => {
            let path = write.path.render(context).map_err(template_error)?;
            let content = write.content.render(context).map_err(template_error)?;
            Ok(ExecutionRequest::WriteFile(RenderedWriteFileRequest {
                cwd: plan.project_root.clone(),
                path: resolve_output_path(&plan.project_root, &path),
                contents: content,
            }))
        }
        StepKind::Claude(claude) => Ok(ExecutionRequest::Claude(RenderedClaudeRequest {
            cwd: plan.project_root.clone(),
            env: step_env.clone(),
            prompt: claude.prompt.render(context).map_err(template_error)?,
            model: claude.model.clone(),
            permission_mode: claude.permission_mode.clone(),
            add_dirs: claude
                .add_dirs
                .iter()
                .map(|dir| dir.render(context).map_err(template_error))
                .collect::<Result<Vec<_>, _>>()?,
            persist: claude.persist,
            result_schema: step.result_schema.clone(),
        })),
        StepKind::Codex(codex) => Ok(ExecutionRequest::Codex(RenderedCodexRequest {
            cwd: plan.project_root.clone(),
            env: step_env.clone(),
            result_schema: step.result_schema.clone(),
            action: match &codex.action {
                CodexAction::Review(review) => {
                    let prompt = review
                        .prompt
                        .as_ref()
                        .map(|prompt| prompt.render(context).map_err(template_error))
                        .transpose()?;
                    RenderedCodexAction::Review {
                        prompt,
                        model: review.model.clone(),
                        mode: review.mode,
                        title: review
                            .title
                            .as_ref()
                            .map(|title| title.render(context).map_err(template_error))
                            .transpose()?,
                        add_dirs: review
                            .add_dirs
                            .iter()
                            .map(|dir| dir.render(context).map_err(template_error))
                            .collect::<Result<Vec<_>, _>>()?,
                        persist: review.persist,
                        scope: match &review.scope {
                            ReviewScope::Uncommitted => RenderedReviewScope::Uncommitted,
                            ReviewScope::Base(base) => RenderedReviewScope::Base(
                                base.render(context).map_err(template_error)?,
                            ),
                            ReviewScope::Commit(commit) => RenderedReviewScope::Commit(
                                commit.render(context).map_err(template_error)?,
                            ),
                        },
                    }
                }
                CodexAction::Exec(exec) => RenderedCodexAction::Exec {
                    prompt: exec.prompt.render(context).map_err(template_error)?,
                    model: exec.model.clone(),
                    mode: exec.mode,
                    add_dirs: exec
                        .add_dirs
                        .iter()
                        .map(|dir| dir.render(context).map_err(template_error))
                        .collect::<Result<Vec<_>, _>>()?,
                    persist: exec.persist,
                },
            },
        })),
    }
}

fn render_env(
    plan: &ExecutionPlan,
    state: &RunState,
    step_env_fields: &[crate::TemplateField],
) -> Result<BTreeMap<String, String>, EngineError> {
    let mut env = plan.parent_env.clone();
    render_env_fields(&plan.flow.env, plan, state, &mut env)?;
    render_env_fields(step_env_fields, plan, state, &mut env)?;
    Ok(env)
}

fn render_env_fields(
    fields: &[crate::TemplateField],
    plan: &ExecutionPlan,
    state: &RunState,
    env: &mut BTreeMap<String, String>,
) -> Result<(), EngineError> {
    for field in fields {
        let context = build_context(plan, state, env);
        let value = field.value.render(&context).map_err(template_error)?;
        env.insert(field.key.clone(), value);
    }
    Ok(())
}

fn finalize_result(
    step: &ValidatedStep,
    result: Option<&CapturedValue>,
) -> Result<Option<CapturedValue>, EngineError> {
    let Some(result) = result else {
        return Ok(None);
    };
    if let Some(schema) = &step.result_schema {
        let value = result.as_json();
        validate_against_schema(&step.id, schema, &value)?;
        Ok(Some(CapturedValue::Json(value)))
    } else {
        Ok(Some(result.clone()))
    }
}

fn extract_outputs(
    step: &ValidatedStep,
    result: Option<&CapturedValue>,
) -> Result<JsonMap<String, JsonValue>, EngineError> {
    let mut outputs = JsonMap::new();
    if step.outputs.is_empty() {
        return Ok(outputs);
    }
    let Some(result) = result else {
        return Err(ResultError::MissingStepResult { step_id: step.id.clone() }.into());
    };
    let value = result.as_json();
    if step.outputs.len() == 1 && !value.is_object() {
        let output = &step.outputs[0];
        validate_output_type(&step.id, &output.key, output.output_type, &value)?;
        outputs.insert(output.key.clone(), value);
        return Ok(outputs);
    }
    let object = value
        .as_object()
        .ok_or_else(|| ResultError::ExpectedObjectResult { step_id: step.id.clone() })?;
    for output in &step.outputs {
        let field = object.get(&output.key).ok_or_else(|| ResultError::MissingOutput {
            step_id: step.id.clone(),
            output: output.key.clone(),
        })?;
        validate_output_type(&step.id, &output.key, output.output_type, field)?;
        outputs.insert(output.key.clone(), field.clone());
    }
    Ok(outputs)
}

fn validate_against_schema(
    step_id: &StepId,
    schema: &JsonValue,
    value: &JsonValue,
) -> Result<(), EngineError> {
    let required =
        schema.get("required").and_then(JsonValue::as_array).cloned().unwrap_or_default();
    let properties = schema
        .get("properties")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| ResultError::MissingSchemaProperties { step_id: step_id.clone() })?;
    let object = value
        .as_object()
        .ok_or_else(|| ResultError::ExpectedStructuredResult { step_id: step_id.clone() })?;

    for required_key in required {
        let key = required_key
            .as_str()
            .ok_or_else(|| ResultError::InvalidRequiredField { step_id: step_id.clone() })?;
        if !object.contains_key(key) {
            return Err(ResultError::MissingRequiredField {
                step_id: step_id.clone(),
                field: key.to_owned(),
            }
            .into());
        }
    }

    for (key, property_schema) in properties {
        if let Some(value) = object.get(key) {
            let output_type = schema_type_to_output_type(step_id, property_schema)?;
            validate_output_type(step_id, key, output_type, value)?;
        }
    }
    Ok(())
}

fn schema_type_to_output_type(
    step_id: &StepId,
    schema: &JsonValue,
) -> Result<OutputType, EngineError> {
    match schema.get("type").and_then(JsonValue::as_str) {
        Some("string") => Ok(OutputType::String),
        Some("integer") => Ok(OutputType::Integer),
        Some("number") => Ok(OutputType::Number),
        Some("boolean") => Ok(OutputType::Boolean),
        Some("object") => Ok(OutputType::Object),
        Some("array") => Ok(OutputType::Array),
        Some(other) => Err(ResultError::UnsupportedSchemaType {
            step_id: step_id.clone(),
            schema_type: other.to_owned(),
        }
        .into()),
        None => Err(ResultError::MissingSchemaType { step_id: step_id.clone() }.into()),
    }
}

fn validate_output_type(
    step_id: &StepId,
    key: &str,
    output_type: OutputType,
    value: &JsonValue,
) -> Result<(), EngineError> {
    if value_matches_output_type(output_type, value) {
        Ok(())
    } else {
        Err(ResultError::OutputTypeMismatch {
            step_id: step_id.clone(),
            output: key.to_owned(),
            expected: output_type,
        }
        .into())
    }
}

fn value_matches_output_type(output_type: OutputType, value: &JsonValue) -> bool {
    match output_type {
        OutputType::String => value.is_string(),
        OutputType::Integer => value.as_i64().is_some() || value.as_u64().is_some(),
        OutputType::Number => value.is_number(),
        OutputType::Boolean => value.is_boolean(),
        OutputType::Object => value.is_object(),
        OutputType::Array => value.is_array(),
    }
}

fn mark_skipped(step_state: &mut StepResult, clock: &dyn Clock) {
    step_state.attempt += 1;
    step_state.status = StepStatus::Skipped;
    let ts = clock.now();
    step_state.started_at = Some(ts.clone());
    step_state.finished_at = Some(ts);
    step_state.duration_ms = Some(0);
    step_state.exit_code = None;
    step_state.stdout_path = None;
    step_state.stderr_path = None;
    step_state.stdout_preview.clear();
    step_state.stderr_preview.clear();
    step_state.stdout = None;
    step_state.stderr = None;
    step_state.result = None;
    step_state.outputs = JsonMap::new();
}

fn resolve_output_path(cwd: &std::path::Path, raw_path: &str) -> PathBuf {
    let path = PathBuf::from(raw_path);
    if path.is_absolute() { path } else { cwd.join(path) }
}

fn build_context(
    plan: &ExecutionPlan,
    state: &RunState,
    env: &BTreeMap<String, String>,
) -> JsonValue {
    expr_context(plan.invocation_inputs.clone(), steps_json(state), env_json(env), run_json(state))
}

fn steps_json(state: &RunState) -> JsonValue {
    JsonValue::Object(
        state
            .steps
            .iter()
            .map(|step| {
                (
                    step.step_id.to_string(),
                    JsonValue::Object(JsonMap::from_iter([
                        (
                            "status".to_owned(),
                            JsonValue::String(step_status_name(step.status).to_owned()),
                        ),
                        (
                            "exit_code".to_owned(),
                            step.exit_code.map_or(JsonValue::Null, JsonValue::from),
                        ),
                        ("outputs".to_owned(), JsonValue::Object(step.outputs.clone())),
                    ])),
                )
            })
            .collect(),
    )
}

fn env_json(env: &BTreeMap<String, String>) -> JsonValue {
    JsonValue::Object(
        env.iter().map(|(key, value)| (key.clone(), JsonValue::String(value.clone()))).collect(),
    )
}

fn run_json(state: &RunState) -> JsonValue {
    JsonValue::Object(JsonMap::from_iter([
        ("iteration".to_owned(), JsonValue::from(state.current_iteration)),
        ("max_iterations".to_owned(), JsonValue::from(state.max_iterations)),
    ]))
}

fn step_status_name(status: StepStatus) -> &'static str {
    match status {
        StepStatus::Pending => "pending",
        StepStatus::Skipped => "skipped",
        StepStatus::Succeeded => "succeeded",
        StepStatus::Failed => "failed",
    }
}

fn preview(text: &str) -> String {
    let compact = text.replace('\n', "\\n");
    compact.chars().take(160).collect()
}

fn eval_error(error: EvalError) -> EngineError {
    EvaluationError::Expr { source: error }.into()
}

fn template_error(error: TemplateError) -> EngineError {
    RenderError::Template { source: error }.into()
}

fn validate_invocation_inputs(flow: &ValidatedFlow, inputs: &JsonValue) -> Result<(), EngineError> {
    let object = inputs.as_object().ok_or(ValidationError::ExpectedObject)?;
    let declared = flow
        .inputs
        .iter()
        .map(|field| (field.key.as_str(), field.input_type))
        .collect::<BTreeMap<_, _>>();

    for key in object.keys() {
        if !declared.contains_key(key.as_str()) {
            return Err(ValidationError::UnexpectedInput { input: key.clone() }.into());
        }
    }
    for field in &flow.inputs {
        let value = object
            .get(&field.key)
            .ok_or_else(|| ValidationError::MissingInput { input: field.key.clone() })?;
        if !value_matches_output_type(field.input_type, value) {
            return Err(ValidationError::TypeMismatch {
                key: field.key.clone(),
                expected: field.input_type,
            }
            .into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ClaudePermissionMode, ClaudeStep, CodexAction, CodexExec, CodexMode, CodexReview,
        CodexStep, FlowName, OutputField, OutputType, ReviewScope, ShellResultMode, ShellStep,
        StepId, StepKind, Template, ValidatedFlow, ValidatedStep,
    };
    use std::cell::RefCell;
    use std::collections::{BTreeMap, VecDeque};
    use std::str::FromStr;

    #[derive(Debug, Default, Clone, Copy)]
    struct FixedClock;

    impl Clock for FixedClock {
        fn now(&self) -> String {
            "2026-01-01T00:00:00Z".to_owned()
        }
    }

    #[derive(Debug)]
    struct FakeExecutor {
        responses: RefCell<VecDeque<StepExecution>>,
    }

    impl FakeExecutor {
        fn new(responses: Vec<StepExecution>) -> Self {
            Self { responses: RefCell::new(VecDeque::from(responses)) }
        }
    }

    impl StepExecutor for FakeExecutor {
        fn execute(&self, _request: &ExecutionRequest) -> Result<StepExecution, EngineError> {
            self.responses.borrow_mut().pop_front().ok_or_else(|| {
                EngineError::Executor(ExecutorError::RunTool {
                    program: "fake-executor".to_owned(),
                    source: std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "missing fake response",
                    ),
                })
            })
        }
    }

    #[derive(Debug, Default)]
    struct MemoryRecorder;

    impl Recorder for MemoryRecorder {
        fn write_meta(&mut self, _meta: &RunMeta) -> Result<(), EngineError> {
            Ok(())
        }

        fn append_event(&mut self, _event: &RunEventRecord) -> Result<(), EngineError> {
            Ok(())
        }

        fn write_state(&mut self, _state: &RunState) -> Result<(), EngineError> {
            Ok(())
        }

        fn log_path(&self, step: &ValidatedStep, attempt: u32, stream: StreamKind) -> String {
            let suffix = match stream {
                StreamKind::Stdout => "stdout",
                StreamKind::Stderr => "stderr",
            };
            format!("{:02}-{}.attempt-{}.{}.log", step.index + 1, step.id, attempt, suffix)
        }

        fn append_log(&mut self, _path: &str, _chunk: &str) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct BrokenRecorder;

    impl Recorder for BrokenRecorder {
        fn write_meta(&mut self, _meta: &RunMeta) -> Result<(), EngineError> {
            Err(RecorderError::EventsPathNotInitialized.into())
        }

        fn append_event(&mut self, _event: &RunEventRecord) -> Result<(), EngineError> {
            Ok(())
        }

        fn write_state(&mut self, _state: &RunState) -> Result<(), EngineError> {
            Ok(())
        }

        fn log_path(&self, _step: &ValidatedStep, _attempt: u32, _stream: StreamKind) -> String {
            String::new()
        }

        fn append_log(&mut self, _path: &str, _chunk: &str) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[test]
    fn validates_structured_result_against_outputs() -> Result<(), Box<dyn std::error::Error>> {
        let executor = FakeExecutor::new(vec![StepExecution {
            started_at: "2026-01-01T00:00:00Z".to_owned(),
            finished_at: "2026-01-01T00:00:01Z".to_owned(),
            duration_ms: 1,
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            result: Some(CapturedValue::Json(serde_json::json!({"markdown":"ok"}))),
        }]);
        let mut recorder = MemoryRecorder;
        let state = Engine.run_plan(structured_plan()?, &executor, &mut recorder, &FixedClock)?;
        assert_eq!(
            state.steps[0].outputs.get("markdown"),
            Some(&JsonValue::String("ok".to_owned()))
        );
        Ok(())
    }

    #[test]
    fn validates_flow_inputs_before_execution() -> Result<(), Box<dyn std::error::Error>> {
        let plan = structured_plan()?;
        let result = validate_invocation_inputs(&plan.flow, &serde_json::json!({}));
        assert!(matches!(
            result,
            Err(EngineError::Validation(ValidationError::MissingInput { .. }))
        ));
        Ok(())
    }

    #[test]
    fn rejects_unexpected_flow_inputs_with_structured_error()
    -> Result<(), Box<dyn std::error::Error>> {
        let plan = structured_plan()?;
        let result = validate_invocation_inputs(
            &plan.flow,
            &serde_json::json!({"requirements":"ok","extra":1}),
        );
        assert!(matches!(
            result,
            Err(EngineError::Validation(ValidationError::UnexpectedInput { input }))
                if input == "extra"
        ));
        Ok(())
    }

    #[test]
    fn extracts_single_output_from_text_result() -> Result<(), Box<dyn std::error::Error>> {
        let step = ValidatedStep {
            id: StepId::from_str("review")?,
            index: 0,
            kind: StepKind::Shell(ShellStep {
                command: Template::parse("echo hi")?,
                result_mode: ShellResultMode::Text,
            }),
            if_expr: None,
            env: vec![],
            outputs: vec![OutputField {
                key: "review".to_owned(),
                output_type: OutputType::String,
            }],
            result_schema: None,
        };
        let outputs = extract_outputs(&step, Some(&CapturedValue::Text("looks good".to_owned())))?;
        assert_eq!(outputs.get("review"), Some(&JsonValue::String("looks good".to_owned())));
        Ok(())
    }

    fn structured_plan() -> Result<ExecutionPlan, Box<dyn std::error::Error>> {
        Ok(ExecutionPlan {
            project_root: std::env::temp_dir(),
            config_files: vec![],
            config_hash: String::new(),
            flow: ValidatedFlow {
                name: FlowName::from_str("plan")?,
                inputs: vec![crate::InputField {
                    key: "requirements".to_owned(),
                    input_type: OutputType::String,
                }],
                steps: vec![ValidatedStep {
                    id: StepId::from_str("improve")?,
                    index: 0,
                    kind: StepKind::Codex(CodexStep {
                        action: CodexAction::Exec(CodexExec {
                            prompt: Template::parse("Refine")?,
                            model: None,
                            mode: CodexMode::Default,
                            add_dirs: vec![],
                            persist: true,
                        }),
                    }),
                    if_expr: None,
                    env: vec![],
                    outputs: vec![OutputField {
                        key: "markdown".to_owned(),
                        output_type: OutputType::String,
                    }],
                    result_schema: Some(serde_json::json!({
                        "type":"object",
                        "required":["markdown"],
                        "properties":{"markdown":{"type":"string"}}
                    })),
                }],
                env: vec![],
                r#loop: None,
            },
            invocation_inputs: serde_json::json!({"requirements":"hello"}),
            parent_env: BTreeMap::new(),
            tool_version: "test".to_owned(),
        })
    }

    #[test]
    fn shell_without_outputs_keeps_text_result() -> Result<(), Box<dyn std::error::Error>> {
        let step = ValidatedStep {
            id: StepId::from_str("shell")?,
            index: 0,
            kind: StepKind::Shell(ShellStep {
                command: Template::parse("echo hi")?,
                result_mode: ShellResultMode::Text,
            }),
            if_expr: None,
            env: vec![],
            outputs: vec![],
            result_schema: None,
        };
        let result = finalize_result(&step, Some(&CapturedValue::Text("hi".to_owned())))?;
        assert_eq!(result, Some(CapturedValue::Text("hi".to_owned())));
        Ok(())
    }

    #[test]
    fn claude_request_uses_structured_schema() -> Result<(), Box<dyn std::error::Error>> {
        let plan = ExecutionPlan {
            project_root: std::env::temp_dir(),
            config_files: vec![],
            config_hash: String::new(),
            flow: ValidatedFlow {
                name: FlowName::from_str("claude")?,
                inputs: vec![crate::InputField {
                    key: "requirements".to_owned(),
                    input_type: OutputType::String,
                }],
                steps: vec![ValidatedStep {
                    id: StepId::from_str("draft")?,
                    index: 0,
                    kind: StepKind::Claude(ClaudeStep {
                        prompt: Template::parse("Draft")?,
                        model: None,
                        permission_mode: ClaudePermissionMode::Default,
                        add_dirs: vec![],
                        persist: true,
                    }),
                    if_expr: None,
                    env: vec![],
                    outputs: vec![OutputField {
                        key: "markdown".to_owned(),
                        output_type: OutputType::String,
                    }],
                    result_schema: Some(serde_json::json!({
                        "type":"object",
                        "required":["markdown"],
                        "properties":{"markdown":{"type":"string"}}
                    })),
                }],
                env: vec![],
                r#loop: None,
            },
            invocation_inputs: serde_json::json!({"requirements":"x"}),
            parent_env: BTreeMap::new(),
            tool_version: String::new(),
        };
        let state = RunState {
            run_id: RunId::new(),
            flow_name: plan.flow.name.clone(),
            status: RunStatus::Running,
            reason: None,
            current_iteration: 0,
            max_iterations: 1,
            started_at: String::new(),
            finished_at: None,
            steps: vec![StepResult {
                step_id: plan.flow.steps[0].id.clone(),
                index: 0,
                attempt: 0,
                status: StepStatus::Pending,
                started_at: None,
                finished_at: None,
                duration_ms: None,
                exit_code: None,
                stdout_path: None,
                stderr_path: None,
                stdout_preview: String::new(),
                stderr_preview: String::new(),
                stdout: None,
                stderr: None,
                result: None,
                outputs: JsonMap::new(),
            }],
        };
        let env = render_env(&plan, &state, &[])?;
        let request =
            render_request(&plan, &plan.flow.steps[0], &env, &build_context(&plan, &state, &env))?;
        match request {
            ExecutionRequest::Claude(request) => assert!(request.result_schema.is_some()),
            other => panic!("unexpected request: {other:?}"),
        }
        Ok(())
    }

    #[test]
    fn render_codex_review_request_includes_commit_scope_and_runtime_options()
    -> Result<(), Box<dyn std::error::Error>> {
        let plan = ExecutionPlan {
            project_root: std::env::temp_dir(),
            config_files: vec![],
            config_hash: String::new(),
            flow: ValidatedFlow {
                name: FlowName::from_str("review")?,
                inputs: vec![],
                steps: vec![ValidatedStep {
                    id: StepId::from_str("review")?,
                    index: 0,
                    kind: StepKind::Codex(CodexStep {
                        action: CodexAction::Review(CodexReview {
                            prompt: Some(Template::parse("Review this")?),
                            model: Some("gpt-5".to_owned()),
                            mode: CodexMode::FullAuto,
                            title: Some(Template::parse("Bug sweep")?),
                            add_dirs: vec![Template::parse("docs")?, Template::parse("notes")?],
                            persist: false,
                            scope: ReviewScope::Commit(Template::parse("abc123")?),
                        }),
                    }),
                    if_expr: None,
                    env: vec![],
                    outputs: vec![],
                    result_schema: None,
                }],
                env: vec![],
                r#loop: None,
            },
            invocation_inputs: serde_json::json!({}),
            parent_env: BTreeMap::new(),
            tool_version: String::new(),
        };
        let state = empty_state(&plan);
        let env = render_env(&plan, &state, &[])?;
        let request =
            render_request(&plan, &plan.flow.steps[0], &env, &build_context(&plan, &state, &env))?;
        match request {
            ExecutionRequest::Codex(RenderedCodexRequest {
                action:
                    RenderedCodexAction::Review {
                        title,
                        add_dirs,
                        persist,
                        scope: RenderedReviewScope::Commit(commit),
                        ..
                    },
                ..
            }) => {
                assert_eq!(title.as_deref(), Some("Bug sweep"));
                assert_eq!(add_dirs, vec!["docs".to_owned(), "notes".to_owned()]);
                assert!(!persist);
                assert_eq!(commit, "abc123");
            }
            other => panic!("unexpected request: {other:?}"),
        }
        Ok(())
    }

    #[test]
    fn render_claude_request_includes_add_dirs_and_persist()
    -> Result<(), Box<dyn std::error::Error>> {
        let plan = ExecutionPlan {
            project_root: std::env::temp_dir(),
            config_files: vec![],
            config_hash: String::new(),
            flow: ValidatedFlow {
                name: FlowName::from_str("claude")?,
                inputs: vec![],
                steps: vec![ValidatedStep {
                    id: StepId::from_str("draft")?,
                    index: 0,
                    kind: StepKind::Claude(ClaudeStep {
                        prompt: Template::parse("Draft")?,
                        model: None,
                        permission_mode: ClaudePermissionMode::Plan,
                        add_dirs: vec![Template::parse("docs")?],
                        persist: false,
                    }),
                    if_expr: None,
                    env: vec![],
                    outputs: vec![],
                    result_schema: None,
                }],
                env: vec![],
                r#loop: None,
            },
            invocation_inputs: serde_json::json!({}),
            parent_env: BTreeMap::new(),
            tool_version: String::new(),
        };
        let state = empty_state(&plan);
        let env = render_env(&plan, &state, &[])?;
        let request =
            render_request(&plan, &plan.flow.steps[0], &env, &build_context(&plan, &state, &env))?;
        match request {
            ExecutionRequest::Claude(request) => {
                assert_eq!(request.add_dirs, vec!["docs".to_owned()]);
                assert!(!request.persist);
                assert_eq!(request.permission_mode, ClaudePermissionMode::Plan);
            }
            other => panic!("unexpected request: {other:?}"),
        }
        Ok(())
    }

    fn empty_state(plan: &ExecutionPlan) -> RunState {
        RunState {
            run_id: RunId::new(),
            flow_name: plan.flow.name.clone(),
            status: RunStatus::Running,
            reason: None,
            current_iteration: 0,
            max_iterations: 1,
            started_at: String::new(),
            finished_at: None,
            steps: vec![StepResult {
                step_id: plan.flow.steps[0].id.clone(),
                index: 0,
                attempt: 0,
                status: StepStatus::Pending,
                started_at: None,
                finished_at: None,
                duration_ms: None,
                exit_code: None,
                stdout_path: None,
                stderr_path: None,
                stdout_preview: String::new(),
                stderr_preview: String::new(),
                stdout: None,
                stderr: None,
                result: None,
                outputs: JsonMap::new(),
            }],
        }
    }

    #[test]
    fn reports_structured_result_errors() -> Result<(), Box<dyn std::error::Error>> {
        let step = ValidatedStep {
            id: StepId::from_str("review")?,
            index: 0,
            kind: StepKind::Shell(ShellStep {
                command: Template::parse("echo hi")?,
                result_mode: ShellResultMode::Json,
            }),
            if_expr: None,
            env: vec![],
            outputs: vec![OutputField {
                key: "count".to_owned(),
                output_type: OutputType::Integer,
            }],
            result_schema: None,
        };

        let error = match extract_outputs(
            &step,
            Some(&CapturedValue::Json(serde_json::json!({"count":"bad"}))),
        ) {
            Ok(_) => panic!("expected output type mismatch"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            EngineError::Result(ResultError::OutputTypeMismatch { ref step_id, ref output, expected })
                if step_id.as_str() == "review" && output == "count" && expected == OutputType::Integer
        ));
        Ok(())
    }

    #[test]
    fn reports_missing_output_with_structured_error() -> Result<(), Box<dyn std::error::Error>> {
        let step = ValidatedStep {
            id: StepId::from_str("review")?,
            index: 0,
            kind: StepKind::Shell(ShellStep {
                command: Template::parse("echo hi")?,
                result_mode: ShellResultMode::Json,
            }),
            if_expr: None,
            env: vec![],
            outputs: vec![OutputField {
                key: "review".to_owned(),
                output_type: OutputType::String,
            }],
            result_schema: None,
        };

        let error = match extract_outputs(&step, Some(&CapturedValue::Json(serde_json::json!({}))))
        {
            Ok(_) => panic!("expected missing output"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            EngineError::Result(ResultError::MissingOutput { ref step_id, ref output })
                if step_id.as_str() == "review" && output == "review"
        ));
        Ok(())
    }

    #[test]
    fn run_plan_surfaces_executor_errors() -> Result<(), Box<dyn std::error::Error>> {
        let executor = FakeExecutor::new(vec![]);
        let mut recorder = MemoryRecorder;
        let error = match Engine.run_plan(structured_plan()?, &executor, &mut recorder, &FixedClock)
        {
            Ok(_) => panic!("expected executor failure"),
            Err(error) => error,
        };
        assert!(matches!(error, EngineError::Executor(ExecutorError::RunTool { .. })));
        Ok(())
    }

    #[test]
    fn run_plan_surfaces_recorder_errors() -> Result<(), Box<dyn std::error::Error>> {
        let executor = FakeExecutor::new(vec![]);
        let mut recorder = BrokenRecorder;
        let error = match Engine.run_plan(structured_plan()?, &executor, &mut recorder, &FixedClock)
        {
            Ok(_) => panic!("expected recorder failure"),
            Err(error) => error,
        };
        assert!(matches!(error, EngineError::Recorder(RecorderError::EventsPathNotInitialized)));
        Ok(())
    }
}
