use crate::{RunSnapshot, event_record_from_core, meta_from_core, snapshot_from_core};
use rigg_core::{
    EngineError, Recorder, RunEventRecord, RunId, RunMeta, RunState, StepId, StreamKind,
    ValidatedStep, engine::RecorderError,
};
use serde_json::to_string;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct StatusQuery {
    pub run_id: Option<RunId>,
}

#[derive(Debug, Clone)]
pub struct LogSelection {
    pub step_id: Option<StepId>,
    pub stream: LogStream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogStream {
    Stdout,
    Stderr,
}

#[derive(Debug)]
pub struct StoreWriter {
    project_root: PathBuf,
    run_dir: Option<PathBuf>,
    events_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct StoreReader {
    project_root: PathBuf,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("failed to read `{path}`: {source}")]
    Read { path: PathBuf, source: std::io::Error },
    #[error("failed to parse `{path}`: {source}")]
    Parse { path: PathBuf, source: serde_json::Error },
    #[error("run `{run_id}` was not found")]
    RunNotFound { run_id: RunId },
    #[error("step log matching selection was not found")]
    LogNotFound,
}

impl StoreWriter {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self { project_root: project_root.into(), run_dir: None, events_path: None }
    }

    fn ensure_run_dir(&self) -> Result<&Path, EngineError> {
        self.run_dir
            .as_deref()
            .ok_or(EngineError::Recorder(RecorderError::RunDirectoryNotInitialized))
    }
}

impl Recorder for StoreWriter {
    fn write_meta(&mut self, meta: &RunMeta) -> Result<(), EngineError> {
        let run_dir = self.project_root.join(".rigg").join("runs").join(meta.run_id.to_string());
        fs::create_dir_all(run_dir.join("logs")).map_err(|source| {
            EngineError::Recorder(RecorderError::CreateDirectory {
                path: run_dir.join("logs"),
                source,
            })
        })?;

        let meta_path = run_dir.join("meta.json");
        let protocol_meta = meta_from_core(meta);
        fs::write(&meta_path, serde_json::to_vec_pretty(&protocol_meta).map_err(json_store_error)?)
            .map_err(|source| {
                EngineError::Recorder(RecorderError::WriteFile { path: meta_path.clone(), source })
            })?;

        self.events_path = Some(run_dir.join("events.jsonl"));
        self.run_dir = Some(run_dir);
        Ok(())
    }

    fn append_event(&mut self, event: &RunEventRecord) -> Result<(), EngineError> {
        let path = self
            .events_path
            .clone()
            .ok_or(EngineError::Recorder(RecorderError::EventsPathNotInitialized))?;
        let mut file =
            OpenOptions::new().create(true).append(true).open(&path).map_err(|source| {
                EngineError::Recorder(RecorderError::OpenFile { path: path.clone(), source })
            })?;
        let protocol_event = event_record_from_core(event);
        writeln!(file, "{}", to_string(&protocol_event).map_err(json_store_error)?)
            .map_err(|source| EngineError::Recorder(RecorderError::AppendFile { path, source }))
    }

    fn write_state(&mut self, state: &RunState) -> Result<(), EngineError> {
        let run_dir = self.ensure_run_dir()?.to_path_buf();
        let state_path = run_dir.join("state.json");
        let temp_path = run_dir.join("state.json.tmp");
        fs::write(
            &temp_path,
            serde_json::to_vec_pretty(&snapshot_from_core(state)).map_err(json_store_error)?,
        )
        .map_err(|source| {
            EngineError::Recorder(RecorderError::WriteFile { path: temp_path.clone(), source })
        })?;
        fs::rename(&temp_path, &state_path).map_err(|source| {
            EngineError::Recorder(RecorderError::ReplaceFile {
                from: temp_path.clone(),
                to: state_path.clone(),
                source,
            })
        })
    }

    fn log_path(&self, step: &ValidatedStep, attempt: u32, stream: StreamKind) -> String {
        let stream = match stream {
            StreamKind::Stdout => "stdout",
            StreamKind::Stderr => "stderr",
        };
        format!("logs/{:02}-{}.attempt-{}.{}.log", step.index + 1, step.id, attempt, stream)
    }

    fn append_log(&mut self, path: &str, chunk: &str) -> Result<(), EngineError> {
        let full_path = self.ensure_run_dir()?.join(path);
        let mut file =
            OpenOptions::new().create(true).append(true).open(&full_path).map_err(|source| {
                EngineError::Recorder(RecorderError::OpenFile { path: full_path.clone(), source })
            })?;
        file.write_all(chunk.as_bytes()).map_err(|source| {
            EngineError::Recorder(RecorderError::AppendFile { path: full_path, source })
        })
    }
}

impl StoreReader {
    pub fn new(project_root: impl Into<PathBuf>) -> Self {
        Self { project_root: project_root.into() }
    }

    pub fn statuses(&self, query: StatusQuery) -> Result<Vec<RunSnapshot>, StoreError> {
        let runs_dir = self.project_root.join(".rigg").join("runs");
        if !runs_dir.exists() {
            return Ok(Vec::new());
        }

        let mut entries = fs::read_dir(&runs_dir)
            .map_err(|source| StoreError::Read { path: runs_dir.clone(), source })?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        entries.sort();
        entries.reverse();

        let mut snapshots = Vec::new();
        for run_dir in entries {
            if let Some(run_id) = &query.run_id {
                let Some(dir_name) = run_dir.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if dir_name != run_id.as_str() {
                    continue;
                }
            }

            let path = run_dir.join("state.json");
            let text = fs::read_to_string(&path)
                .map_err(|source| StoreError::Read { path: path.clone(), source })?;
            let snapshot = serde_json::from_str(&text)
                .map_err(|source| StoreError::Parse { path: path.clone(), source })?;
            snapshots.push(snapshot);
        }

        Ok(snapshots)
    }

    pub fn logs(&self, run_id: &RunId, selection: LogSelection) -> Result<String, StoreError> {
        let logs_dir =
            self.project_root.join(".rigg").join("runs").join(run_id.as_str()).join("logs");
        if !logs_dir.exists() {
            return Err(StoreError::RunNotFound { run_id: run_id.clone() });
        }

        let mut files = fs::read_dir(&logs_dir)
            .map_err(|source| StoreError::Read { path: logs_dir.clone(), source })?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        files.sort();

        let stream = match selection.stream {
            LogStream::Stdout => "stdout",
            LogStream::Stderr => "stderr",
        };
        let matching = files
            .into_iter()
            .filter(|path| {
                let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                    return false;
                };
                file_name.ends_with(&format!("{stream}.log"))
                    && selection
                        .step_id
                        .as_ref()
                        .is_none_or(|step_id| file_name.contains(step_id.as_str()))
            })
            .collect::<Vec<_>>();

        if matching.is_empty() {
            return Err(StoreError::LogNotFound);
        }

        let mut output = String::new();
        for path in matching {
            output.push_str(&format!(
                "== {} ==\n",
                path.file_name().and_then(|name| name.to_str()).unwrap_or("log")
            ));
            output.push_str(
                &fs::read_to_string(&path)
                    .map_err(|source| StoreError::Read { path: path.clone(), source })?,
            );
            if !output.ends_with('\n') {
                output.push('\n');
            }
        }
        Ok(output)
    }
}

fn json_store_error(error: serde_json::Error) -> EngineError {
    EngineError::Recorder(RecorderError::SerializeJson {
        operation: "store payload",
        source: error,
    })
}

#[cfg(test)]
mod tests {
    use super::{LogSelection, LogStream, StatusQuery, StoreError, StoreReader};
    use rigg_core::{RunId, StepId};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn filters_statuses_by_typed_run_id() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("status-query");
        let runs_dir = project_root.join(".rigg").join("runs");
        fs::create_dir_all(runs_dir.join("019cc300-0000-7000-8000-000000000001"))?;
        fs::create_dir_all(runs_dir.join("019cc300-0000-7000-8000-000000000002"))?;
        fs::write(
            runs_dir.join("019cc300-0000-7000-8000-000000000001").join("state.json"),
            snapshot_json("019cc300-0000-7000-8000-000000000001"),
        )?;
        fs::write(
            runs_dir.join("019cc300-0000-7000-8000-000000000002").join("state.json"),
            snapshot_json("019cc300-0000-7000-8000-000000000002"),
        )?;

        let snapshots = StoreReader::new(&project_root).statuses(StatusQuery {
            run_id: Some("019cc300-0000-7000-8000-000000000002".parse()?),
        })?;

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].run_id, "019cc300-0000-7000-8000-000000000002");
        Ok(())
    }

    #[test]
    fn filters_logs_by_typed_step_id_and_stream() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("log-query");
        let run_id: RunId = "019cc300-0000-7000-8000-000000000003".parse()?;
        let logs_dir =
            project_root.join(".rigg").join("runs").join(run_id.to_string()).join("logs");
        fs::create_dir_all(&logs_dir)?;
        fs::write(logs_dir.join("01-build.attempt-1.stdout.log"), "stdout\n")?;
        fs::write(logs_dir.join("01-build.attempt-1.stderr.log"), "stderr\n")?;
        fs::write(logs_dir.join("02-test.attempt-1.stdout.log"), "other\n")?;

        let output = StoreReader::new(&project_root).logs(
            &run_id,
            LogSelection { step_id: Some("build".parse::<StepId>()?), stream: LogStream::Stderr },
        )?;

        assert!(output.contains("01-build.attempt-1.stderr.log"));
        assert!(output.contains("stderr"));
        assert!(!output.contains("stdout"));
        Ok(())
    }

    #[test]
    fn returns_typed_run_not_found() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("run-not-found");
        let run_id: RunId = "019cc300-0000-7000-8000-000000000004".parse()?;
        let error = match StoreReader::new(&project_root)
            .logs(&run_id, LogSelection { step_id: None, stream: LogStream::Stdout })
        {
            Ok(_) => panic!("missing run should error"),
            Err(error) => error,
        };

        assert!(matches!(error, StoreError::RunNotFound { run_id: missing } if missing == run_id));
        Ok(())
    }

    fn temp_project_root(label: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("rigg-store-{label}-{suffix}"))
    }

    fn snapshot_json(run_id: &str) -> String {
        serde_json::json!({
            "run_id": run_id,
            "flow_name": "plan",
            "status": "succeeded",
            "reason": "completed",
            "current_iteration": 1,
            "max_iterations": 1,
            "started_at": "2026-01-01T00:00:00Z",
            "finished_at": "2026-01-01T00:00:01Z",
            "steps": []
        })
        .to_string()
    }
}
