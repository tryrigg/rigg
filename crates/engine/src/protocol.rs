use rigg_core::progress::{ProviderEvent, StepProgressSink};
use rigg_core::{
    CapturedValue, CodexMode, ConversationHandle, FrameId, NodePath, PermissionMode, Persistence,
    RunEventRecord, RunMeta, RunState, ShellOutput, StreamKind, ValidatedWorkflow,
};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ExecutionPlan {
    pub project_root: PathBuf,
    pub config_files: Vec<PathBuf>,
    pub config_hash: String,
    pub workflow: ValidatedWorkflow,
    pub invocation_inputs: JsonValue,
    pub parent_env: BTreeMap<String, String>,
    pub tool_version: String,
}

pub trait Clock: Sync {
    fn now(&self) -> String;
}

#[derive(Debug, Clone)]
pub enum StepRunRequest {
    Codex(RenderedCodexRequest),
    Claude(RenderedClaudeRequest),
    Shell(RenderedShellRequest),
    WriteFile(RenderedWriteFileRequest),
}

impl StepRunRequest {
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
    pub artifacts_dir: PathBuf,
    pub env: BTreeMap<String, String>,
    pub result_schema: Option<JsonValue>,
    pub conversation: Option<RenderedCodexConversation>,
    pub action: RenderedCodexAction,
}

impl RenderedCodexRequest {
    fn label(&self) -> String {
        match &self.action {
            RenderedCodexAction::Review { prompt, .. } => {
                format_codex_label(self.action.label_prefix(), prompt.as_deref())
            }
            RenderedCodexAction::Exec { prompt, .. } => {
                format_codex_label(self.action.label_prefix(), Some(prompt))
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedCodexConversation {
    pub resume_thread_id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum RenderedCodexAction {
    Review {
        prompt: Option<String>,
        model: Option<String>,
        mode: CodexMode,
        title: Option<String>,
        add_dirs: Vec<String>,
        persistence: Persistence,
        scope: RenderedReviewScope,
    },
    Exec {
        prompt: String,
        model: Option<String>,
        mode: CodexMode,
        add_dirs: Vec<String>,
        persistence: Persistence,
    },
}

impl RenderedCodexAction {
    fn label_prefix(&self) -> &'static str {
        match self {
            Self::Review { .. } => "codex exec review",
            Self::Exec { .. } => "codex exec",
        }
    }
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
    pub permission_mode: PermissionMode,
    pub add_dirs: Vec<String>,
    pub persistence: Persistence,
    pub conversation: Option<RenderedClaudeConversation>,
    pub result_schema: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedClaudeConversation {
    pub resume_session_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RenderedShellRequest {
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub command: String,
    pub result_mode: ShellOutput,
}

#[derive(Debug, Clone)]
pub struct RenderedWriteFileRequest {
    pub cwd: PathBuf,
    pub path: PathBuf,
    pub contents: String,
}

#[derive(Debug, Clone)]
pub struct StepRunResult {
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u128,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub result: Option<CapturedValue>,
    pub conversation_handle: Option<ConversationHandle>,
    pub provider_events: Vec<ProviderEvent>,
}

pub trait StepRunner: Sync {
    fn run_step(
        &self,
        request: &StepRunRequest,
        progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, crate::EngineError>;
}

pub trait RunRecorder: Sync {
    fn init_run(&mut self, state: &RunState, meta: &RunMeta) -> Result<(), crate::EngineError>;
    fn append_event(&mut self, event: &RunEventRecord) -> Result<(), crate::EngineError>;
    fn write_state(&mut self, state: &RunState) -> Result<(), crate::EngineError>;
    /// Returns the run artifacts root. Relative paths are interpreted from the workflow cwd.
    fn run_artifacts_dir(&self) -> Result<PathBuf, crate::EngineError>;
    fn log_path(
        &self,
        frame_id: &FrameId,
        node_path: &NodePath,
        attempt: u32,
        stream: StreamKind,
    ) -> String;
    fn append_log(&mut self, path: &str, chunk: &str) -> Result<(), crate::EngineError>;
}

#[derive(Debug, Default)]
pub struct Engine;

pub(super) fn format_log_path(
    frame_id: &FrameId,
    node_path: &NodePath,
    attempt: u32,
    stream: StreamKind,
) -> String {
    format!(
        "logs/frame={frame_id}.path={}.attempt-{}.{}.log",
        node_path.file_component(),
        attempt,
        match stream {
            StreamKind::Stdout => "stdout",
            StreamKind::Stderr => "stderr",
        }
    )
}

pub(super) fn preview(text: &str) -> String {
    let compact = text.replace('\n', "\\n");
    compact.chars().take(160).collect()
}

fn format_codex_label(prefix: &str, prompt: Option<&str>) -> String {
    match prompt {
        Some(prompt) => format!("{prefix} {}", preview(prompt)),
        None => prefix.to_owned(),
    }
}
