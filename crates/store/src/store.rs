use rigg_core::{FrameId, NodePath, RunId, StreamKind};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LogFileName {
    pub frame_id: FrameId,
    pub node_path: NodePath,
    pub attempt: u32,
    pub stream: StreamKind,
}

#[derive(Debug, Clone)]
pub struct RunStore {
    pub(super) project_root: PathBuf,
}

#[derive(Debug)]
pub struct FsRunRecorder {
    pub(super) project_root: PathBuf,
    pub(super) run_dir: Option<PathBuf>,
    pub(super) events_path: Option<PathBuf>,
}

impl RunStore {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self { project_root: project_root.into() }
    }
}

impl FsRunRecorder {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self { project_root: project_root.into(), run_dir: None, events_path: None }
    }
}

pub(super) fn runs_dir(project_root: &Path) -> PathBuf {
    project_root.join(".rigg").join("runs")
}

pub(super) fn run_dir(project_root: &Path, run_id: &RunId) -> PathBuf {
    runs_dir(project_root).join(run_id.as_str())
}

pub(super) fn staging_run_dir(project_root: &Path, run_id: &RunId) -> PathBuf {
    runs_dir(project_root).join(format!(".tmp-{}", run_id.as_str()))
}

pub(super) fn logs_dir(project_root: &Path, run_id: &RunId) -> PathBuf {
    run_dir(project_root, run_id).join("logs")
}

pub(super) fn meta_path(run_dir: &Path) -> PathBuf {
    run_dir.join("meta.json")
}

pub(super) fn state_path(run_dir: &Path) -> PathBuf {
    run_dir.join("state.json")
}

pub(super) fn temp_state_path(run_dir: &Path) -> PathBuf {
    run_dir.join("state.json.tmp")
}

pub(super) fn events_path(run_dir: &Path) -> PathBuf {
    run_dir.join("events.jsonl")
}

pub(super) fn artifacts_dir(run_dir: &Path) -> PathBuf {
    run_dir.join("artifacts")
}

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

pub(super) fn parse_log_file_name(file_name: &str) -> Option<LogFileName> {
    let frame_prefix = "frame=";
    let frame_start = file_name.find(frame_prefix)? + frame_prefix.len();
    let rest = &file_name[frame_start..];
    let (frame_id, rest) = rest.split_once(".path=")?;
    let (node_component, rest) = rest.split_once(".attempt-")?;
    let (attempt, stream) = rest.split_once('.')?;
    let attempt = attempt.parse().ok()?;
    let stream = match stream.strip_suffix(".log")? {
        "stdout" => StreamKind::Stdout,
        "stderr" => StreamKind::Stderr,
        _ => return None,
    };

    Some(LogFileName {
        frame_id: FrameId::try_from(frame_id).ok()?,
        node_path: NodePath::from_file_component(node_component).ok()?,
        attempt,
        stream,
    })
}
