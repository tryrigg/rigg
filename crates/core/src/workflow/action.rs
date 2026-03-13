use super::schema::{JsonResultSchema, OutputSchema};
use crate::conversation::ConversationBinding;
use crate::expr::Template;
use serde_json::{Value as JsonValue, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionNode {
    pub action: ActionKind,
    pub result_contract: ResultContract,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionKind {
    Codex(CodexStep),
    Claude(ClaudeStep),
    Shell(ShellStep),
    WriteFile(WriteFileStep),
}

impl ActionKind {
    pub(super) fn label(&self) -> &'static str {
        match self {
            Self::Codex(_) => "codex",
            Self::Claude(_) => "claude",
            Self::Shell(_) => "shell",
            Self::WriteFile(_) => "write_file",
        }
    }

    pub fn conversation_binding(&self) -> Option<&ConversationBinding> {
        match self {
            Self::Claude(step) => step.conversation.as_ref(),
            Self::Codex(step) => step.action.conversation_binding(),
            Self::Shell(_) | Self::WriteFile(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultContract {
    None,
    Text,
    Json { schema: Option<JsonResultSchema> },
    Review { schema: JsonResultSchema },
    WriteFile,
}

impl ResultContract {
    pub fn result_schema(&self) -> Option<&OutputSchema> {
        match self {
            Self::Json { schema } => schema.as_ref().map(JsonResultSchema::structured),
            Self::Review { schema } => Some(schema.structured()),
            Self::None | Self::Text | Self::WriteFile => None,
        }
    }

    pub fn provider_schema(&self) -> Option<&JsonValue> {
        match self {
            Self::Json { schema } => schema.as_ref().map(JsonResultSchema::json_schema),
            Self::Review { .. } | Self::None | Self::Text | Self::WriteFile => None,
        }
    }
}

pub fn codex_review_result_schema() -> JsonResultSchema {
    match JsonResultSchema::parse_at(
        &json!({
            "type": "object",
            "required": [
                "findings",
                "overall_correctness",
                "overall_explanation",
                "overall_confidence_score"
            ],
            "additionalProperties": false,
            "properties": {
                "findings": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": [
                            "title",
                            "body",
                            "confidence_score",
                            "code_location"
                        ],
                        "additionalProperties": false,
                        "properties": {
                            "title": { "type": "string" },
                            "body": { "type": "string" },
                            "confidence_score": { "type": "number" },
                            "priority": { "type": ["integer", "null"] },
                            "code_location": {
                                "type": "object",
                                "required": ["absolute_file_path", "line_range"],
                                "additionalProperties": false,
                                "properties": {
                                    "absolute_file_path": { "type": "string" },
                                    "line_range": {
                                        "type": "object",
                                        "required": ["start", "end"],
                                        "additionalProperties": false,
                                        "properties": {
                                            "start": { "type": "integer" },
                                            "end": { "type": "integer" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                "overall_correctness": { "type": "string" },
                "overall_explanation": { "type": "string" },
                "overall_confidence_score": { "type": "number" }
            }
        }),
        "with.review_output_schema",
    ) {
        Ok(schema) => schema,
        Err(error) => panic!("internal codex review schema must remain valid: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::codex_review_result_schema;
    use serde_json::json;

    #[test]
    fn codex_review_schema_accepts_missing_priority() {
        codex_review_result_schema()
            .structured()
            .validate_value(
                None,
                &json!({
                    "findings": [
                        {
                            "title": "[P1] Example finding",
                            "body": "Body",
                            "confidence_score": 0.9,
                            "code_location": {
                                "absolute_file_path": "/tmp/example.rs",
                                "line_range": { "start": 10, "end": 12 }
                            }
                        }
                    ],
                    "overall_correctness": "patch is incorrect",
                    "overall_explanation": "Explanation",
                    "overall_confidence_score": 0.8
                }),
            )
            .expect("missing priority should be accepted");
    }

    #[test]
    fn codex_review_schema_accepts_null_priority() {
        codex_review_result_schema()
            .structured()
            .validate_value(
                None,
                &json!({
                    "findings": [
                        {
                            "title": "[P1] Example finding",
                            "body": "Body",
                            "confidence_score": 0.9,
                            "priority": null,
                            "code_location": {
                                "absolute_file_path": "/tmp/example.rs",
                                "line_range": { "start": 10, "end": 12 }
                            }
                        }
                    ],
                    "overall_correctness": "patch is incorrect",
                    "overall_explanation": "Explanation",
                    "overall_confidence_score": 0.8
                }),
            )
            .expect("null priority should be accepted");
    }
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

impl CodexAction {
    pub fn conversation_binding(&self) -> Option<&ConversationBinding> {
        match self {
            Self::Exec(exec) => exec.conversation.as_ref(),
            Self::Review(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexReview {
    pub prompt: Option<Template>,
    pub model: Option<String>,
    pub mode: CodexMode,
    pub title: Option<Template>,
    pub add_dirs: Vec<Template>,
    pub persistence: Persistence,
    pub scope: ReviewScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexExec {
    pub prompt: Template,
    pub model: Option<String>,
    pub mode: CodexMode,
    pub add_dirs: Vec<Template>,
    pub persistence: Persistence,
    pub conversation: Option<ConversationBinding>,
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
    pub permission_mode: PermissionMode,
    pub add_dirs: Vec<Template>,
    pub persistence: Persistence,
    pub conversation: Option<ConversationBinding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Persistence {
    Persist,
    Ephemeral,
}

impl Persistence {
    pub fn persists(self) -> bool {
        matches!(self, Self::Persist)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionMode {
    Default,
    Plan,
    AcceptEdits,
    DontAsk,
    BypassPermissions,
}

impl PermissionMode {
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
    pub result_mode: ShellOutput,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteFileStep {
    pub path: Template,
    pub content: Template,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellOutput {
    None,
    Text,
    Json,
}
