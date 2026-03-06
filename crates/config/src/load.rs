use crate::model::{ConfigDiscovery, RawFlow, RawFlowFile, RawStep, SourceLocation};
use rigg_core::{
    ClaudePermissionMode, ClaudeStep, CodexAction, CodexExec, CodexMode, CodexReview, CodexStep,
    CompiledExpr, ExpectedType, ExprError, ExprRoot, FlowEnv, FlowName, InputField, LoadedFile,
    OutputField, OutputType, PathReference, ReviewScope, ShellResultMode, ShellStep, StepId,
    StepKind, Template, TemplateError, TemplateField, ValidatedFlow, ValidatedFlowFile,
    ValidatedLoop, ValidatedStep, WriteFileStep,
};
use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("could not find `.rigg/*.yaml` from `{start}`")]
    NotFound { start: PathBuf },
    #[error("failed to read config file `{path}`: {source}")]
    ReadFile { path: PathBuf, source: std::io::Error },
    #[error("failed to parse YAML in `{path}` at {location}: {message}")]
    ParseFile { path: PathBuf, location: SourceLocation, message: String },
    #[error("flow `{flow_name}` is defined more than once (`{first}` and `{second}`)")]
    DuplicateFlow { flow_name: String, first: PathBuf, second: PathBuf },
    #[error("flow `{flow_name}` has invalid name in `{path}` at {location}")]
    InvalidFlowName { path: PathBuf, location: SourceLocation, flow_name: String },
    #[error("flow `{flow_name}` has no steps in `{path}` at {location}")]
    EmptySteps { path: PathBuf, location: SourceLocation, flow_name: String },
    #[error("step {step_index} in flow `{flow_name}` is missing `id` in `{path}` at {location}")]
    MissingStepId { path: PathBuf, location: SourceLocation, flow_name: String, step_index: usize },
    #[error(
        "step {step_index} in flow `{flow_name}` has invalid id `{step_id}` in `{path}` at {location}"
    )]
    InvalidStepId {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        step_index: usize,
        step_id: String,
    },
    #[error("flow `{flow_name}` has duplicate step id `{step_id}` in `{path}` at {location}")]
    DuplicateStepId { path: PathBuf, location: SourceLocation, flow_name: String, step_id: String },
    #[error(
        "step {step_index} in flow `{flow_name}` uses unsupported type `{step_type}` in `{path}` at {location}"
    )]
    UnsupportedStepType {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        step_index: usize,
        step_type: String,
    },
    #[error(
        "step {step_index} in flow `{flow_name}` has invalid `with` for `{step_type}` in `{path}` at {location}: {message}"
    )]
    InvalidWith {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        step_index: usize,
        step_type: String,
        message: String,
    },
    #[error(
        "step {step_index} in flow `{flow_name}` must use `${{ ... }}` for `{field}` in `{path}` at {location}"
    )]
    InvalidExprTemplate {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        step_index: usize,
        field: String,
    },
    #[error("flow `{flow_name}` references future step `{step_id}` in `{path}` at {location}")]
    ForwardStepReference {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        step_id: String,
    },
    #[error("flow `{flow_name}` cannot use `{root}` in `{field}` in `{path}` at {location}")]
    InvalidExprRoot {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        field: String,
        root: String,
    },
    #[error(
        "flow `{flow_name}` has invalid reference in `{field}` in `{path}` at {location}: {message}"
    )]
    InvalidReference {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        field: String,
        message: String,
    },
    #[error("flow `{flow_name}` has invalid input `{input}` in `{path}` at {location}: {message}")]
    InvalidInput {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        input: String,
        message: String,
    },
    #[error(
        "step {step_index} in flow `{flow_name}` has invalid output `{output}` in `{path}` at {location}: {message}"
    )]
    InvalidOutput {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        step_index: usize,
        output: String,
        message: String,
    },
    #[error(
        "step {step_index} in flow `{flow_name}` must declare `with.result: json` when returning multiple outputs in `{path}` at {location}"
    )]
    OutputsRequireObjectResult {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        step_index: usize,
    },
    #[error("flow `{flow_name}` has invalid expression in `{path}` at {location}: {source}")]
    Expr {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        #[source]
        source: Box<ExprError>,
    },
    #[error("flow `{flow_name}` has invalid template in `{path}` at {location}: {source}")]
    Template {
        path: PathBuf,
        location: SourceLocation,
        flow_name: String,
        #[source]
        source: Box<TemplateError>,
    },
    #[error("flow `{flow_name}` has invalid `loop.max` in `{path}` at {location}; it must be >= 1")]
    InvalidLoopMax { path: PathBuf, location: SourceLocation, flow_name: String },
}

#[derive(Debug, Default)]
pub struct ConfigLoader;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCodexWith {
    action: RawCodexAction,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    mode: Option<RawCodexMode>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    target: Option<RawReviewTarget>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    commit: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    add_dirs: Vec<String>,
    #[serde(default)]
    persist: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawClaudeWith {
    #[serde(rename = "action")]
    _action: RawClaudeAction,
    prompt: String,
    #[serde(default)]
    permission_mode: Option<RawClaudePermissionMode>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    add_dirs: Vec<String>,
    #[serde(default)]
    persist: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawShellWith {
    command: String,
    #[serde(default)]
    result: Option<RawShellResultMode>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawWriteFileWith {
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawFieldDecl {
    Shorthand(RawFieldType),
    Detailed(RawFieldObject),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFieldObject {
    #[serde(rename = "type")]
    field_type: RawFieldType,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawCodexAction {
    Review,
    Exec,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawCodexMode {
    Default,
    FullAuto,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawReviewTarget {
    Uncommitted,
    Base,
    Commit,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawClaudeAction {
    Prompt,
}

#[derive(Debug, Clone, Copy, Deserialize)]
enum RawClaudePermissionMode {
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "plan")]
    Plan,
    #[serde(rename = "acceptEdits")]
    AcceptEdits,
    #[serde(rename = "dontAsk")]
    DontAsk,
    #[serde(rename = "bypassPermissions")]
    BypassPermissions,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawShellResultMode {
    None,
    Text,
    Json,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawFieldType {
    String,
    Integer,
    Number,
    Boolean,
    Object,
    Array,
}

impl From<RawCodexMode> for CodexMode {
    fn from(value: RawCodexMode) -> Self {
        match value {
            RawCodexMode::Default => Self::Default,
            RawCodexMode::FullAuto => Self::FullAuto,
        }
    }
}

impl From<RawClaudePermissionMode> for ClaudePermissionMode {
    fn from(value: RawClaudePermissionMode) -> Self {
        match value {
            RawClaudePermissionMode::Default => Self::Default,
            RawClaudePermissionMode::Plan => Self::Plan,
            RawClaudePermissionMode::AcceptEdits => Self::AcceptEdits,
            RawClaudePermissionMode::DontAsk => Self::DontAsk,
            RawClaudePermissionMode::BypassPermissions => Self::BypassPermissions,
        }
    }
}

impl From<RawFieldType> for OutputType {
    fn from(value: RawFieldType) -> Self {
        match value {
            RawFieldType::String => Self::String,
            RawFieldType::Integer => Self::Integer,
            RawFieldType::Number => Self::Number,
            RawFieldType::Boolean => Self::Boolean,
            RawFieldType::Object => Self::Object,
            RawFieldType::Array => Self::Array,
        }
    }
}

#[derive(Clone, Copy)]
struct FieldSite<'a> {
    path: &'a Path,
    flow_name: &'a FlowName,
    step_index: usize,
    location: SourceLocation,
}

#[derive(Clone, Copy)]
struct ExprRules<'a> {
    allowed_roots: &'a [ExprRoot],
    flow_inputs: &'a BTreeMap<String, OutputType>,
    known_steps: &'a BTreeMap<String, BTreeMap<String, OutputType>>,
}

impl ConfigLoader {
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

    pub fn load(start: impl AsRef<Path>) -> Result<ValidatedFlowFile, ConfigError> {
        let discovery = Self::discover(start)?;
        let files = discovery
            .files
            .iter()
            .map(|path| {
                fs::read_to_string(path)
                    .map(|contents| LoadedFile { path: path.clone(), contents })
                    .map_err(|source| ConfigError::ReadFile { path: path.clone(), source })
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut raw_flows = BTreeMap::new();
        for file in &files {
            let parsed =
                RawFlowFile::parse(&file.contents).map_err(|error| ConfigError::ParseFile {
                    path: file.path.clone(),
                    location: error.location().map(Into::into).unwrap_or_default(),
                    message: error.to_string(),
                })?;

            for (flow_name, raw_flow) in parsed.flows {
                if let Some(previous) =
                    raw_flows.insert(flow_name.clone(), (file.path.clone(), raw_flow))
                {
                    return Err(ConfigError::DuplicateFlow {
                        flow_name,
                        first: previous.0,
                        second: file.path.clone(),
                    });
                }
            }
        }

        let mut flows = BTreeMap::new();
        for (name, (path, raw_flow)) in raw_flows {
            let flow_name =
                FlowName::from_str(&name).map_err(|_| ConfigError::InvalidFlowName {
                    path: path.clone(),
                    location: raw_flow.location,
                    flow_name: name.clone(),
                })?;
            flows.insert(flow_name.clone(), validate_flow(&path, &flow_name, raw_flow)?);
        }

        Ok(ValidatedFlowFile {
            project_root: discovery.project_root,
            rigg_dir: discovery.rigg_dir,
            files,
            flows,
        })
    }
}

fn validate_flow(
    path: &Path,
    flow_name: &FlowName,
    raw_flow: RawFlow,
) -> Result<ValidatedFlow, ConfigError> {
    if raw_flow.steps.is_empty() {
        return Err(ConfigError::EmptySteps {
            path: path.to_path_buf(),
            location: raw_flow.location,
            flow_name: flow_name.to_string(),
        });
    }

    let flow_inputs = compile_input_fields(
        FieldSite { path, flow_name, step_index: 0, location: raw_flow.location },
        raw_flow.inputs,
    )?;
    let flow_input_map = flow_inputs
        .iter()
        .map(|field| (field.key.clone(), field.input_type))
        .collect::<BTreeMap<_, _>>();

    let no_steps = BTreeMap::new();
    let flow_env = compile_env(
        FieldSite { path, flow_name, step_index: 0, location: raw_flow.location },
        raw_flow.env,
        ExprRules {
            allowed_roots: &[ExprRoot::Inputs],
            flow_inputs: &flow_input_map,
            known_steps: &no_steps,
        },
    )?;

    let mut seen_step_ids = BTreeSet::new();
    let mut previous_outputs = BTreeMap::new();
    let mut steps = Vec::new();

    for (index, raw_step) in raw_flow.steps.into_iter().enumerate() {
        let step_index = index + 1;
        let location = raw_step.location;
        let step_id = validate_step_id(path, flow_name, step_index, location, raw_step.id.clone())?;
        if seen_step_ids.contains(&step_id) {
            return Err(ConfigError::DuplicateStepId {
                path: path.to_path_buf(),
                location,
                flow_name: flow_name.to_string(),
                step_id,
            });
        }
        seen_step_ids.insert(step_id.clone());

        let step = validate_step(
            path,
            flow_name,
            index,
            raw_step,
            StepId::from_str(&step_id).map_err(|_| ConfigError::InvalidStepId {
                path: path.to_path_buf(),
                location,
                flow_name: flow_name.to_string(),
                step_index,
                step_id: step_id.clone(),
            })?,
            &flow_input_map,
            &previous_outputs,
        )?;
        previous_outputs.insert(step_id, outputs_map(&step.outputs));
        steps.push(step);
    }

    let validated_loop = raw_flow
        .r#loop
        .map(|loop_config| {
            if loop_config.max == 0 {
                return Err(ConfigError::InvalidLoopMax {
                    path: path.to_path_buf(),
                    location: loop_config.location,
                    flow_name: flow_name.to_string(),
                });
            }

            Ok(ValidatedLoop {
                until: compile_wrapped_expr(
                    FieldSite { path, flow_name, step_index: 0, location: loop_config.location },
                    "loop.until",
                    &loop_config.until,
                    Some(ExpectedType::Bool),
                    ExprRules {
                        allowed_roots: &[
                            ExprRoot::Inputs,
                            ExprRoot::Env,
                            ExprRoot::Steps,
                            ExprRoot::Run,
                        ],
                        flow_inputs: &flow_input_map,
                        known_steps: &previous_outputs,
                    },
                )?,
                max: loop_config.max,
            })
        })
        .transpose()?;

    Ok(ValidatedFlow {
        name: flow_name.clone(),
        inputs: flow_inputs,
        steps,
        env: flow_env,
        r#loop: validated_loop,
    })
}

fn validate_step_id(
    path: &Path,
    flow_name: &FlowName,
    step_index: usize,
    location: SourceLocation,
    id: Option<String>,
) -> Result<String, ConfigError> {
    let id = id.ok_or_else(|| ConfigError::MissingStepId {
        path: path.to_path_buf(),
        location,
        flow_name: flow_name.to_string(),
        step_index,
    })?;
    if StepId::from_str(&id).is_err() {
        return Err(ConfigError::InvalidStepId {
            path: path.to_path_buf(),
            location,
            flow_name: flow_name.to_string(),
            step_index,
            step_id: id,
        });
    }
    Ok(id)
}

fn validate_step(
    path: &Path,
    flow_name: &FlowName,
    index: usize,
    raw_step: RawStep,
    id: StepId,
    flow_inputs: &BTreeMap<String, OutputType>,
    previous_outputs: &BTreeMap<String, BTreeMap<String, OutputType>>,
) -> Result<ValidatedStep, ConfigError> {
    let site = FieldSite { path, flow_name, step_index: index + 1, location: raw_step.location };
    let rules = ExprRules {
        allowed_roots: &[ExprRoot::Inputs, ExprRoot::Env, ExprRoot::Steps, ExprRoot::Run],
        flow_inputs,
        known_steps: previous_outputs,
    };

    let outputs = compile_outputs(site, raw_step.outputs)?;
    let kind = compile_step_kind(site, &raw_step.step_type, raw_step.with, outputs.len(), rules)?;
    let if_expr = raw_step
        .if_expr
        .as_ref()
        .map(|expr| compile_wrapped_expr(site, "if", expr, Some(ExpectedType::Bool), rules))
        .transpose()?;
    let env = compile_env(site, raw_step.env, rules)?;
    let result_schema = compile_result_schema(&kind, &outputs);

    Ok(ValidatedStep { id, index, kind, if_expr, env, outputs, result_schema })
}

fn compile_step_kind(
    site: FieldSite<'_>,
    step_type: &str,
    with: Option<JsonValue>,
    output_count: usize,
    rules: ExprRules<'_>,
) -> Result<StepKind, ConfigError> {
    match step_type {
        "codex" => compile_codex(site, with, rules),
        "claude" => compile_claude(site, with, rules),
        "shell" => compile_shell(site, with, output_count, rules),
        "write_file" => compile_write_file(site, with, rules),
        _ => Err(ConfigError::UnsupportedStepType {
            path: site.path.to_path_buf(),
            location: site.location,
            flow_name: site.flow_name.to_string(),
            step_index: site.step_index,
            step_type: step_type.to_owned(),
        }),
    }
}

fn compile_codex(
    site: FieldSite<'_>,
    with: Option<JsonValue>,
    rules: ExprRules<'_>,
) -> Result<StepKind, ConfigError> {
    let with = with.ok_or_else(|| invalid_with(site, "codex", "missing `with`".to_owned()))?;
    let raw: RawCodexWith = deserialize_with(site, "codex", with)?;
    let persist = raw.persist.unwrap_or(true);
    let add_dirs = compile_template_list(site, "with.add_dirs", raw.add_dirs, rules)?;
    match raw.action {
        RawCodexAction::Review => {
            let scope = match (raw.target.as_ref(), raw.base.as_ref(), raw.commit.as_ref()) {
                (Some(RawReviewTarget::Uncommitted), None, None) => ReviewScope::Uncommitted,
                (Some(RawReviewTarget::Base), Some(base), None) | (None, Some(base), None) => {
                    ReviewScope::Base(compile_template(site, "with.base", base.clone(), rules)?)
                }
                (Some(RawReviewTarget::Commit), None, Some(commit)) => ReviewScope::Commit(
                    compile_template(site, "with.commit", commit.clone(), rules)?,
                ),
                _ => {
                    return Err(invalid_with(
                        site,
                        "codex",
                        "`review` requires exactly one of `target: uncommitted`, `target: base` with `base`, or `target: commit` with `commit`"
                            .to_owned(),
                    ));
                }
            };
            Ok(StepKind::Codex(CodexStep {
                action: CodexAction::Review(CodexReview {
                    prompt: raw
                        .prompt
                        .map(|prompt| compile_template(site, "with.prompt", prompt, rules))
                        .transpose()?,
                    model: raw.model,
                    mode: raw.mode.unwrap_or(RawCodexMode::Default).into(),
                    title: raw
                        .title
                        .map(|title| compile_template(site, "with.title", title, rules))
                        .transpose()?,
                    add_dirs,
                    persist,
                    scope,
                }),
            }))
        }
        RawCodexAction::Exec => {
            if raw.target.is_some()
                || raw.base.is_some()
                || raw.commit.is_some()
                || raw.title.is_some()
            {
                return Err(invalid_with(
                    site,
                    "codex",
                    "`exec` does not accept `target`, `base`, `commit`, or `title`".to_owned(),
                ));
            }
            Ok(StepKind::Codex(CodexStep {
                action: CodexAction::Exec(CodexExec {
                    prompt: compile_template(
                        site,
                        "with.prompt",
                        raw.prompt.ok_or_else(|| {
                            invalid_with(site, "codex", "`exec` requires `prompt`".to_owned())
                        })?,
                        rules,
                    )?,
                    model: raw.model,
                    mode: raw.mode.unwrap_or(RawCodexMode::Default).into(),
                    add_dirs,
                    persist,
                }),
            }))
        }
    }
}

fn compile_claude(
    site: FieldSite<'_>,
    with: Option<JsonValue>,
    rules: ExprRules<'_>,
) -> Result<StepKind, ConfigError> {
    let with = with.ok_or_else(|| invalid_with(site, "claude", "missing `with`".to_owned()))?;
    let raw: RawClaudeWith = deserialize_with(site, "claude", with)?;
    Ok(StepKind::Claude(ClaudeStep {
        prompt: compile_template(site, "with.prompt", raw.prompt, rules)?,
        model: raw.model,
        permission_mode: raw.permission_mode.unwrap_or(RawClaudePermissionMode::Default).into(),
        add_dirs: compile_template_list(site, "with.add_dirs", raw.add_dirs, rules)?,
        persist: raw.persist.unwrap_or(true),
    }))
}

fn compile_shell(
    site: FieldSite<'_>,
    with: Option<JsonValue>,
    output_count: usize,
    rules: ExprRules<'_>,
) -> Result<StepKind, ConfigError> {
    let with = with.ok_or_else(|| invalid_with(site, "shell", "missing `with`".to_owned()))?;
    let raw: RawShellWith = deserialize_with(site, "shell", with)?;
    Ok(StepKind::Shell(ShellStep {
        command: compile_template(site, "with.command", raw.command, rules)?,
        result_mode: resolve_shell_result_mode(site, raw.result, output_count)?,
    }))
}

fn compile_write_file(
    site: FieldSite<'_>,
    with: Option<JsonValue>,
    rules: ExprRules<'_>,
) -> Result<StepKind, ConfigError> {
    let with = with.ok_or_else(|| invalid_with(site, "write_file", "missing `with`".to_owned()))?;
    let raw: RawWriteFileWith = deserialize_with(site, "write_file", with)?;
    Ok(StepKind::WriteFile(WriteFileStep {
        path: compile_template(site, "with.path", raw.path, rules)?,
        content: compile_template(site, "with.content", raw.content, rules)?,
    }))
}

fn compile_env(
    site: FieldSite<'_>,
    env: BTreeMap<String, String>,
    rules: ExprRules<'_>,
) -> Result<FlowEnv, ConfigError> {
    env.into_iter()
        .map(|(key, value)| {
            compile_template(site, &format!("env.{key}"), value, rules)
                .map(|value| TemplateField { key, value })
        })
        .collect()
}

fn compile_input_fields(
    site: FieldSite<'_>,
    inputs: BTreeMap<String, JsonValue>,
) -> Result<Vec<InputField>, ConfigError> {
    inputs
        .into_iter()
        .map(|(key, value)| {
            let field_type =
                parse_field_type(value).map_err(|message| ConfigError::InvalidInput {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    flow_name: site.flow_name.to_string(),
                    input: key.clone(),
                    message,
                })?;
            Ok(InputField { key, input_type: field_type })
        })
        .collect()
}

fn compile_outputs(
    site: FieldSite<'_>,
    outputs: BTreeMap<String, JsonValue>,
) -> Result<Vec<OutputField>, ConfigError> {
    outputs
        .into_iter()
        .map(|(key, value)| {
            let output_type =
                parse_field_type(value).map_err(|message| ConfigError::InvalidOutput {
                    path: site.path.to_path_buf(),
                    location: site.location,
                    flow_name: site.flow_name.to_string(),
                    step_index: site.step_index,
                    output: key.clone(),
                    message,
                })?;
            Ok(OutputField { key, output_type })
        })
        .collect()
}

fn parse_field_type(value: JsonValue) -> Result<OutputType, String> {
    let raw: RawFieldDecl = serde_json::from_value(value).map_err(|error| error.to_string())?;
    Ok(match raw {
        RawFieldDecl::Shorthand(field_type) => field_type.into(),
        RawFieldDecl::Detailed(object) => object.field_type.into(),
    })
}

fn compile_result_schema(kind: &StepKind, outputs: &[OutputField]) -> Option<JsonValue> {
    if outputs.is_empty() {
        return None;
    }

    match kind {
        StepKind::Claude(_) => Some(build_result_schema(outputs)),
        StepKind::Codex(step) if matches!(step.action, CodexAction::Exec(_)) => {
            Some(build_result_schema(outputs))
        }
        _ => None,
    }
}

fn build_result_schema(outputs: &[OutputField]) -> JsonValue {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": outputs.iter().map(|output| output.key.clone()).collect::<Vec<_>>(),
        "properties": outputs.iter().map(|output| (output.key.clone(), output.output_type.to_schema())).collect::<serde_json::Map<_, _>>(),
    })
}

fn outputs_map(outputs: &[OutputField]) -> BTreeMap<String, OutputType> {
    outputs.iter().map(|field| (field.key.clone(), field.output_type)).collect()
}

fn compile_template(
    site: FieldSite<'_>,
    field: &str,
    source: String,
    rules: ExprRules<'_>,
) -> Result<Template, ConfigError> {
    let template = Template::parse(source).map_err(|source| ConfigError::Template {
        path: site.path.to_path_buf(),
        location: site.location,
        flow_name: site.flow_name.to_string(),
        source: Box::new(source),
    })?;
    for expression in template.compiled_expressions() {
        validate_expr_usage(site, field, expression, rules)?;
    }
    Ok(template)
}

fn compile_template_list(
    site: FieldSite<'_>,
    field: &str,
    sources: Vec<String>,
    rules: ExprRules<'_>,
) -> Result<Vec<Template>, ConfigError> {
    sources
        .into_iter()
        .enumerate()
        .map(|(index, source)| compile_template(site, &format!("{field}[{index}]"), source, rules))
        .collect()
}

fn compile_wrapped_expr(
    site: FieldSite<'_>,
    field: &str,
    source: &str,
    expected: Option<ExpectedType>,
    rules: ExprRules<'_>,
) -> Result<CompiledExpr, ConfigError> {
    let trimmed = source.trim();
    let Some(inner) = trimmed.strip_prefix("${{").and_then(|value| value.strip_suffix("}}")) else {
        return Err(ConfigError::InvalidExprTemplate {
            path: site.path.to_path_buf(),
            location: site.location,
            flow_name: site.flow_name.to_string(),
            step_index: site.step_index,
            field: field.to_owned(),
        });
    };
    let expr = CompiledExpr::compile(inner.trim().to_owned(), expected).map_err(|source| {
        ConfigError::Expr {
            path: site.path.to_path_buf(),
            location: site.location,
            flow_name: site.flow_name.to_string(),
            source: Box::new(source),
        }
    })?;
    validate_expr_usage(site, field, &expr, rules)?;
    Ok(expr)
}

fn validate_expr_usage(
    site: FieldSite<'_>,
    field: &str,
    expr: &CompiledExpr,
    rules: ExprRules<'_>,
) -> Result<(), ConfigError> {
    let allowed_roots = rules.allowed_roots.iter().copied().collect::<BTreeSet<_>>();
    for root in expr.roots() {
        if !allowed_roots.contains(root) {
            return Err(ConfigError::InvalidExprRoot {
                path: site.path.to_path_buf(),
                location: site.location,
                flow_name: site.flow_name.to_string(),
                field: field.to_owned(),
                root: root.as_str().to_owned(),
            });
        }
    }

    for reference in expr.path_references() {
        match reference.root {
            ExprRoot::Inputs => {
                validate_input_reference(site, field, reference, rules.flow_inputs)?
            }
            ExprRoot::Steps => validate_step_reference(site, field, reference, rules.known_steps)?,
            ExprRoot::Env | ExprRoot::Run => {}
        }
    }

    Ok(())
}

fn validate_input_reference(
    site: FieldSite<'_>,
    field: &str,
    reference: &PathReference,
    flow_inputs: &BTreeMap<String, OutputType>,
) -> Result<(), ConfigError> {
    let Some(input_name) = reference.segments.first() else {
        return Err(invalid_reference(
            site,
            field,
            "`inputs` must reference a declared field".to_owned(),
        ));
    };
    if !flow_inputs.contains_key(input_name) {
        return Err(invalid_reference(
            site,
            field,
            format!("`inputs.{input_name}` is not declared by the flow"),
        ));
    }
    Ok(())
}

fn validate_step_reference(
    site: FieldSite<'_>,
    field: &str,
    reference: &PathReference,
    known_steps: &BTreeMap<String, BTreeMap<String, OutputType>>,
) -> Result<(), ConfigError> {
    let Some(step_id) = reference.segments.first() else {
        return Err(invalid_reference(
            site,
            field,
            "`steps` must reference a previous step id".to_owned(),
        ));
    };
    let Some(outputs) = known_steps.get(step_id) else {
        return Err(ConfigError::ForwardStepReference {
            path: site.path.to_path_buf(),
            location: site.location,
            flow_name: site.flow_name.to_string(),
            step_id: step_id.clone(),
        });
    };
    match reference.segments.get(1).map(String::as_str) {
        Some("status") | Some("exit_code") if reference.segments.len() == 2 => Ok(()),
        Some("outputs") => {
            let Some(output_name) = reference.segments.get(2) else {
                return Err(invalid_reference(
                    site,
                    field,
                    format!("`steps.{step_id}.outputs` must reference a declared output field"),
                ));
            };
            if reference.segments.len() != 3 {
                return Err(invalid_reference(
                    site,
                    field,
                    format!("`steps.{step_id}.outputs.{output_name}` cannot access nested fields"),
                ));
            }
            if outputs.contains_key(output_name) {
                Ok(())
            } else {
                Err(invalid_reference(
                    site,
                    field,
                    format!("`steps.{step_id}.outputs.{output_name}` is not declared"),
                ))
            }
        }
        Some(other) => Err(invalid_reference(
            site,
            field,
            format!(
                "`steps.{step_id}.{other}` is not available; use `status`, `exit_code`, or `outputs.<name>`"
            ),
        )),
        None => Err(invalid_reference(
            site,
            field,
            format!("`steps.{step_id}` must access `status`, `exit_code`, or `outputs.<name>`"),
        )),
    }
}

fn resolve_shell_result_mode(
    site: FieldSite<'_>,
    raw: Option<RawShellResultMode>,
    output_count: usize,
) -> Result<ShellResultMode, ConfigError> {
    match raw {
        Some(RawShellResultMode::None) if output_count == 0 => Ok(ShellResultMode::None),
        Some(RawShellResultMode::None) => Err(ConfigError::OutputsRequireObjectResult {
            path: site.path.to_path_buf(),
            location: site.location,
            flow_name: site.flow_name.to_string(),
            step_index: site.step_index,
        }),
        Some(RawShellResultMode::Text) if output_count <= 1 => Ok(ShellResultMode::Text),
        Some(RawShellResultMode::Text) => Err(ConfigError::OutputsRequireObjectResult {
            path: site.path.to_path_buf(),
            location: site.location,
            flow_name: site.flow_name.to_string(),
            step_index: site.step_index,
        }),
        Some(RawShellResultMode::Json) => Ok(ShellResultMode::Json),
        None if output_count == 0 => Ok(ShellResultMode::Text),
        None => Ok(ShellResultMode::Json),
    }
}

fn deserialize_with<T: for<'de> Deserialize<'de>>(
    site: FieldSite<'_>,
    step_type: &str,
    with: JsonValue,
) -> Result<T, ConfigError> {
    serde_json::from_value(with).map_err(|error| invalid_with(site, step_type, error.to_string()))
}

fn invalid_with(site: FieldSite<'_>, step_type: &str, message: String) -> ConfigError {
    ConfigError::InvalidWith {
        path: site.path.to_path_buf(),
        location: site.location,
        flow_name: site.flow_name.to_string(),
        step_index: site.step_index,
        step_type: step_type.to_owned(),
        message,
    }
}

fn invalid_reference(site: FieldSite<'_>, field: &str, message: String) -> ConfigError {
    ConfigError::InvalidReference {
        path: site.path.to_path_buf(),
        location: site.location,
        flow_name: site.flow_name.to_string(),
        field: field.to_owned(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_step_id() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  invalid:
    steps:
      - type: shell
        with:
          command: echo hi
"#,
        )?;
        let flow_name = FlowName::from_str("invalid")?;
        let error =
            validate_flow(Path::new("invalid.yaml"), &flow_name, raw.flows["invalid"].clone())
                .err()
                .ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::MissingStepId { .. }));
        Ok(())
    }

    #[test]
    fn rejects_undeclared_input_reference() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  invalid:
    steps:
      - id: first
        type: shell
        with:
          command: echo ${{ inputs.requirements }}
"#,
        )?;
        let flow_name = FlowName::from_str("invalid")?;
        let error =
            validate_flow(Path::new("invalid.yaml"), &flow_name, raw.flows["invalid"].clone())
                .err()
                .ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::InvalidReference { .. }));
        Ok(())
    }

    #[test]
    fn rejects_unknown_step_output_reference() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  invalid:
    steps:
      - id: first
        type: shell
        with:
          command: printf '%s' '{"count":1}'
        outputs:
          count: integer
      - id: second
        type: shell
        with:
          command: echo ${{ steps.first.outputs.missing }}
"#,
        )?;
        let flow_name = FlowName::from_str("invalid")?;
        let error =
            validate_flow(Path::new("invalid.yaml"), &flow_name, raw.flows["invalid"].clone())
                .err()
                .ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::InvalidReference { .. }));
        Ok(())
    }

    #[test]
    fn infers_json_shell_result_when_outputs_exist() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  valid:
    steps:
      - id: produce
        type: shell
        with:
          command: echo hi
        outputs:
          count: integer
"#,
        )?;
        let flow_name = FlowName::from_str("valid")?;
        let flow = validate_flow(Path::new("valid.yaml"), &flow_name, raw.flows["valid"].clone())?;
        match &flow.steps[0].kind {
            StepKind::Shell(step) => assert_eq!(step.result_mode, ShellResultMode::Json),
            other => panic!("unexpected step kind: {other:?}"),
        }
        Ok(())
    }

    #[test]
    fn rejects_invalid_flow_name_when_loading() -> Result<(), Box<dyn std::error::Error>> {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("rigg-config-invalid-flow-{suffix}"));
        fs::create_dir_all(root.join(".rigg"))?;
        fs::write(
            root.join(".rigg").join("invalid.yaml"),
            r#"
flows:
  bad flow:
    steps:
      - id: build
        type: shell
        with:
          command: echo hi
"#,
        )?;

        let error = ConfigLoader::load(&root).err().ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::InvalidFlowName { .. }));
        Ok(())
    }

    #[test]
    fn rejects_invalid_codex_mode() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  invalid:
    steps:
      - id: review
        type: codex
        with:
          action: exec
          prompt: hello
          mode: turbo
"#,
        )?;
        let flow_name = FlowName::from_str("invalid")?;
        let error =
            validate_flow(Path::new("invalid.yaml"), &flow_name, raw.flows["invalid"].clone())
                .err()
                .ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::InvalidWith { .. }));
        Ok(())
    }

    #[test]
    fn rejects_review_without_required_commit_value() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  invalid:
    steps:
      - id: review
        type: codex
        with:
          action: review
          target: commit
"#,
        )?;
        let flow_name = FlowName::from_str("invalid")?;
        let error =
            validate_flow(Path::new("invalid.yaml"), &flow_name, raw.flows["invalid"].clone())
                .err()
                .ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::InvalidWith { .. }));
        Ok(())
    }

    #[test]
    fn rejects_exec_with_review_only_fields() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  invalid:
    steps:
      - id: exec
        type: codex
        with:
          action: exec
          prompt: hello
          title: bug sweep
"#,
        )?;
        let flow_name = FlowName::from_str("invalid")?;
        let error =
            validate_flow(Path::new("invalid.yaml"), &flow_name, raw.flows["invalid"].clone())
                .err()
                .ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::InvalidWith { .. }));
        Ok(())
    }

    #[test]
    fn accepts_review_commit_scope() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  valid:
    steps:
      - id: review
        type: codex
        with:
          action: review
          target: commit
          commit: abc123
          title: Bug sweep
          add_dirs:
            - docs
          persist: false
"#,
        )?;
        let flow_name = FlowName::from_str("valid")?;
        let flow = validate_flow(Path::new("valid.yaml"), &flow_name, raw.flows["valid"].clone())?;
        match &flow.steps[0].kind {
            StepKind::Codex(step) => match &step.action {
                CodexAction::Review(review) => {
                    assert!(matches!(review.scope, ReviewScope::Commit(_)));
                    assert!(review.title.is_some());
                    assert_eq!(review.add_dirs.len(), 1);
                    assert!(!review.persist);
                }
                other => panic!("unexpected codex action: {other:?}"),
            },
            other => panic!("unexpected step kind: {other:?}"),
        }
        Ok(())
    }

    #[test]
    fn rejects_invalid_permission_mode() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  invalid:
    steps:
      - id: ask
        type: claude
        with:
          action: prompt
          prompt: hello
          permission_mode: maybe
"#,
        )?;
        let flow_name = FlowName::from_str("invalid")?;
        let error =
            validate_flow(Path::new("invalid.yaml"), &flow_name, raw.flows["invalid"].clone())
                .err()
                .ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::InvalidWith { .. }));
        Ok(())
    }

    #[test]
    fn rejects_invalid_field_type() -> Result<(), Box<dyn std::error::Error>> {
        let raw = RawFlowFile::parse(
            r#"
flows:
  invalid:
    inputs:
      requirements: markdown
    steps:
      - id: build
        type: shell
        with:
          command: echo hi
"#,
        )?;
        let flow_name = FlowName::from_str("invalid")?;
        let error =
            validate_flow(Path::new("invalid.yaml"), &flow_name, raw.flows["invalid"].clone())
                .err()
                .ok_or("expected validation failure")?;
        assert!(matches!(error, ConfigError::InvalidInput { .. }));
        Ok(())
    }
}
