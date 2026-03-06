use crate::expr::{CompiledExpr, Template};
use crate::ids::{FlowName, StepId};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedFile {
    pub path: PathBuf,
    pub contents: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateField {
    pub key: String,
    pub value: Template,
}

pub type FlowEnv = Vec<TemplateField>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedLoop {
    pub until: CompiledExpr,
    pub max: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedFlow {
    pub name: FlowName,
    pub inputs: Vec<InputField>,
    pub steps: Vec<ValidatedStep>,
    pub env: FlowEnv,
    pub r#loop: Option<ValidatedLoop>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedFlowFile {
    pub project_root: PathBuf,
    pub rigg_dir: PathBuf,
    pub files: Vec<LoadedFile>,
    pub flows: BTreeMap<FlowName, ValidatedFlow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedStep {
    pub id: StepId,
    pub index: usize,
    pub kind: StepKind,
    pub if_expr: Option<CompiledExpr>,
    pub env: FlowEnv,
    pub outputs: Vec<OutputField>,
    pub result_schema: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepKind {
    Codex(CodexStep),
    Claude(ClaudeStep),
    Shell(ShellStep),
    WriteFile(WriteFileStep),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexStep {
    pub action: CodexAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexAction {
    Review(CodexReview),
    Exec(CodexExec),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexReview {
    pub prompt: Option<Template>,
    pub model: Option<String>,
    pub mode: CodexMode,
    pub title: Option<Template>,
    pub add_dirs: Vec<Template>,
    pub persist: bool,
    pub scope: ReviewScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexExec {
    pub prompt: Template,
    pub model: Option<String>,
    pub mode: CodexMode,
    pub add_dirs: Vec<Template>,
    pub persist: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexMode {
    Default,
    FullAuto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewScope {
    Uncommitted,
    Base(Template),
    Commit(Template),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeStep {
    pub prompt: Template,
    pub model: Option<String>,
    pub permission_mode: ClaudePermissionMode,
    pub add_dirs: Vec<Template>,
    pub persist: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudePermissionMode {
    Default,
    Plan,
    AcceptEdits,
    DontAsk,
    BypassPermissions,
}

impl ClaudePermissionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Plan => "plan",
            Self::AcceptEdits => "acceptEdits",
            Self::DontAsk => "dontAsk",
            Self::BypassPermissions => "bypassPermissions",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellStep {
    pub command: Template,
    pub result_mode: ShellResultMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteFileStep {
    pub path: Template,
    pub content: Template,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellResultMode {
    None,
    Text,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputField {
    pub key: String,
    pub output_type: OutputType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputField {
    pub key: String,
    pub input_type: OutputType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputType {
    String,
    Integer,
    Number,
    Boolean,
    Object,
    Array,
}

impl OutputType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::String => "string",
            Self::Integer => "integer",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Object => "object",
            Self::Array => "array",
        }
    }

    pub fn to_schema(self) -> JsonValue {
        serde_json::json!({
            "type": self.as_str(),
        })
    }
}

impl Display for OutputType {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl ValidatedStep {
    pub fn compiled_expressions(&self) -> Vec<&CompiledExpr> {
        let mut expressions = Vec::new();

        if let Some(if_expr) = &self.if_expr {
            expressions.push(if_expr);
        }

        match &self.kind {
            StepKind::Codex(step) => match &step.action {
                CodexAction::Review(review) => {
                    if let Some(prompt) = &review.prompt {
                        expressions.extend(prompt.compiled_expressions());
                    }
                    if let Some(title) = &review.title {
                        expressions.extend(title.compiled_expressions());
                    }
                    for add_dir in &review.add_dirs {
                        expressions.extend(add_dir.compiled_expressions());
                    }
                    match &review.scope {
                        ReviewScope::Uncommitted => {}
                        ReviewScope::Base(base) | ReviewScope::Commit(base) => {
                            expressions.extend(base.compiled_expressions());
                        }
                    }
                }
                CodexAction::Exec(exec) => {
                    expressions.extend(exec.prompt.compiled_expressions());
                    for add_dir in &exec.add_dirs {
                        expressions.extend(add_dir.compiled_expressions());
                    }
                }
            },
            StepKind::Claude(step) => {
                expressions.extend(step.prompt.compiled_expressions());
                for add_dir in &step.add_dirs {
                    expressions.extend(add_dir.compiled_expressions());
                }
            }
            StepKind::Shell(step) => expressions.extend(step.command.compiled_expressions()),
            StepKind::WriteFile(step) => {
                expressions.extend(step.path.compiled_expressions());
                expressions.extend(step.content.compiled_expressions());
            }
        }

        for field in &self.env {
            expressions.extend(field.value.compiled_expressions());
        }

        expressions
    }
}
