use crate::{RunSnapshot, store};
use rigg_core::{NodePath, RunId};
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct StatusQuery {
    pub run_id: Option<RunId>,
}

#[derive(Debug, Clone)]
pub struct LogSelection {
    pub node: Option<String>,
    pub stream: LogStream,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("failed to read `{path}`: {source}")]
    Read { path: PathBuf, source: std::io::Error },
    #[error("failed to parse `{path}`: {source}")]
    Parse { path: PathBuf, source: serde_json::Error },
    #[error("run `{run_id}` was not found")]
    RunNotFound { run_id: RunId },
    #[error("node log matching selection was not found")]
    LogNotFound,
}

impl crate::store::RunStore {
    pub fn statuses(&self, query: StatusQuery) -> Result<Vec<RunSnapshot>, StoreError> {
        let runs_dir = store::runs_dir(&self.project_root);
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
            let Some(run_id) = run_dir
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.parse::<RunId>().ok())
            else {
                continue;
            };
            if query.run_id.as_ref().is_some_and(|requested| requested != &run_id) {
                continue;
            }

            if let Some(snapshot) = self.read_status_snapshot(&run_dir)? {
                snapshots.push(snapshot);
            }
        }

        Ok(snapshots)
    }

    pub fn logs(&self, run_id: &RunId, selection: LogSelection) -> Result<String, StoreError> {
        let logs_dir = store::logs_dir(&self.project_root, run_id);
        if !logs_dir.exists() {
            return Err(StoreError::RunNotFound { run_id: run_id.clone() });
        }

        let files = fs::read_dir(&logs_dir)
            .map_err(|source| StoreError::Read { path: logs_dir.clone(), source })?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();

        let stream = match selection.stream {
            LogStream::Stdout => rigg_core::StreamKind::Stdout,
            LogStream::Stderr => rigg_core::StreamKind::Stderr,
        };
        let requested_node_path = selection
            .node
            .as_deref()
            .map(|selector| self.resolve_log_node_path(run_id, selector))
            .transpose()?;

        let mut matching = files
            .into_iter()
            .filter_map(|path| {
                let file_name = path.file_name().and_then(|name| name.to_str())?;
                let parsed = store::parse_log_file_name(file_name)?;
                if parsed.stream != stream {
                    return None;
                }
                if requested_node_path
                    .as_ref()
                    .is_some_and(|node_path| parsed.node_path != *node_path)
                {
                    return None;
                }
                Some((parsed, path))
            })
            .collect::<Vec<_>>();
        matching.sort_by(|(left, left_path), (right, right_path)| {
            left.node_path
                .cmp(&right.node_path)
                .then_with(|| left.frame_id.cmp(&right.frame_id))
                .then_with(|| left.attempt.cmp(&right.attempt))
                .then_with(|| left_path.cmp(right_path))
        });

        if matching.is_empty() {
            return Err(StoreError::LogNotFound);
        }

        let mut output = String::new();
        for (_, path) in matching {
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

    fn resolve_log_node_path(
        &self,
        run_id: &RunId,
        selector: &str,
    ) -> Result<NodePath, StoreError> {
        if let Ok(node_path) = NodePath::try_from(selector) {
            return Ok(node_path);
        }

        let snapshot = self.read_run_snapshot(run_id)?;
        let node_path = snapshot
            .nodes
            .iter()
            .find(|node| node.user_id.as_deref() == Some(selector))
            .map(|node| node.node_path.as_str())
            .ok_or(StoreError::LogNotFound)?;

        NodePath::try_from(node_path).map_err(|_| StoreError::LogNotFound)
    }

    fn read_run_snapshot(&self, run_id: &RunId) -> Result<RunSnapshot, StoreError> {
        let run_dir = store::run_dir(&self.project_root, run_id);
        if !run_dir.exists() {
            return Err(StoreError::RunNotFound { run_id: run_id.clone() });
        }

        let path = run_dir.join("state.json");
        let text = fs::read_to_string(&path)
            .map_err(|source| StoreError::Read { path: path.clone(), source })?;
        serde_json::from_str(&text).map_err(|source| StoreError::Parse { path, source })
    }

    fn read_status_snapshot(
        &self,
        run_dir: &std::path::Path,
    ) -> Result<Option<RunSnapshot>, StoreError> {
        let path = run_dir.join("state.json");
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(source) if source.kind() == ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(StoreError::Read { path, source }),
        };
        let snapshot =
            serde_json::from_str(&text).map_err(|source| StoreError::Parse { path, source })?;
        Ok(Some(snapshot))
    }
}

#[cfg(test)]
mod tests {
    use super::{LogSelection, LogStream, StatusQuery, StoreError};
    use crate::{RunStore, store};
    use rigg_core::{FrameId, NodePath, RunId, StreamKind};
    use std::fs;
    use std::path::{Path, PathBuf};

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

        let snapshots = RunStore::new(&project_root).statuses(StatusQuery {
            run_id: Some("019cc300-0000-7000-8000-000000000002".parse()?),
        })?;

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].run_id, "019cc300-0000-7000-8000-000000000002");
        Ok(())
    }

    #[test]
    fn skips_incomplete_runs_without_state() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("status-query-incomplete");
        let runs_dir = project_root.join(".rigg").join("runs");
        let complete_run = runs_dir.join("019cc300-0000-7000-8000-000000000001");
        let incomplete_run = runs_dir.join("019cc300-0000-7000-8000-000000000002");
        fs::create_dir_all(&complete_run)?;
        fs::create_dir_all(&incomplete_run)?;
        fs::write(
            complete_run.join("state.json"),
            snapshot_json("019cc300-0000-7000-8000-000000000001"),
        )?;
        fs::write(
            incomplete_run.join("meta.json"),
            r#"{"run_id":"019cc300-0000-7000-8000-000000000002"}"#,
        )?;

        let snapshots = RunStore::new(&project_root).statuses(StatusQuery { run_id: None })?;

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].run_id, "019cc300-0000-7000-8000-000000000001");
        Ok(())
    }

    #[test]
    fn ignores_non_run_id_directories() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("status-query-staging");
        let runs_dir = project_root.join(".rigg").join("runs");
        let complete_run = runs_dir.join("019cc300-0000-7000-8000-000000000001");
        let staging_run = runs_dir.join(".tmp-019cc300-0000-7000-8000-000000000002");
        fs::create_dir_all(&complete_run)?;
        fs::create_dir_all(&staging_run)?;
        fs::write(
            complete_run.join("state.json"),
            snapshot_json("019cc300-0000-7000-8000-000000000001"),
        )?;
        fs::write(
            staging_run.join("state.json"),
            snapshot_json("019cc300-0000-7000-8000-000000000002"),
        )?;

        let snapshots = RunStore::new(&project_root).statuses(StatusQuery { run_id: None })?;

        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].run_id, "019cc300-0000-7000-8000-000000000001");
        Ok(())
    }

    #[test]
    fn filters_logs_by_node_path_and_stream() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("log-query");
        let run_id: RunId = "019cc300-0000-7000-8000-000000000003".parse()?;
        write_snapshot(
            &project_root,
            &run_id,
            serde_json::json!([
                {
                    "node_path": "/0",
                    "user_id": "produce",
                    "attempt": 1,
                    "status": "succeeded",
                    "started_at": "2026-01-01T00:00:00Z",
                    "finished_at": "2026-01-01T00:00:01Z",
                    "duration_ms": 1,
                    "exit_code": 0,
                    "stdout_path": null,
                    "stderr_path": null,
                    "stdout_preview": "",
                    "stderr_preview": "",
                    "stdout": null,
                    "stderr": null,
                    "result": null
                }
            ]),
        )?;
        let logs_dir =
            project_root.join(".rigg").join("runs").join(run_id.to_string()).join("logs");
        fs::create_dir_all(&logs_dir)?;
        let stdout_log = format_log_name(NodePath::root_child(0), 1, StreamKind::Stdout);
        let stderr_log = format_log_name(NodePath::root_child(0), 1, StreamKind::Stderr);
        let other_log = format_log_name(NodePath::root_child(1), 1, StreamKind::Stdout);
        fs::write(logs_dir.join(&stdout_log), "stdout\n")?;
        fs::write(logs_dir.join(&stderr_log), "stderr\n")?;
        fs::write(logs_dir.join(&other_log), "other\n")?;

        let output = RunStore::new(&project_root).logs(
            &run_id,
            LogSelection {
                node: Some(NodePath::root_child(0).to_string()),
                stream: LogStream::Stderr,
            },
        )?;

        assert!(output.contains(&stderr_log));
        assert!(output.contains("stderr"));
        assert!(!output.contains("stdout"));
        Ok(())
    }

    #[test]
    fn filters_logs_by_displayed_user_id() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("log-user-id");
        let run_id: RunId = "019cc300-0000-7000-8000-000000000006".parse()?;
        write_snapshot(
            &project_root,
            &run_id,
            serde_json::json!([
                {
                    "node_path": "/0",
                    "user_id": "produce",
                    "attempt": 1,
                    "status": "succeeded",
                    "started_at": "2026-01-01T00:00:00Z",
                    "finished_at": "2026-01-01T00:00:01Z",
                    "duration_ms": 1,
                    "exit_code": 0,
                    "stdout_path": null,
                    "stderr_path": null,
                    "stdout_preview": "",
                    "stderr_preview": "",
                    "stdout": null,
                    "stderr": null,
                    "result": null
                }
            ]),
        )?;
        let logs_dir =
            project_root.join(".rigg").join("runs").join(run_id.to_string()).join("logs");
        fs::create_dir_all(&logs_dir)?;
        let stdout_log = format_log_name(NodePath::root_child(0), 1, StreamKind::Stdout);
        fs::write(logs_dir.join(&stdout_log), "stdout\n")?;

        let output = RunStore::new(&project_root).logs(
            &run_id,
            LogSelection { node: Some("produce".to_owned()), stream: LogStream::Stdout },
        )?;

        assert!(output.contains(&stdout_log));
        assert!(output.contains("stdout"));
        Ok(())
    }

    #[test]
    fn logs_follow_structural_node_order() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("log-order");
        let run_id: RunId = "019cc300-0000-7000-8000-000000000005".parse()?;
        let logs_dir =
            project_root.join(".rigg").join("runs").join(run_id.to_string()).join("logs");
        fs::create_dir_all(&logs_dir)?;
        fs::write(
            logs_dir.join(format_log_name(NodePath::root_child(10), 1, StreamKind::Stdout)),
            "ten\n",
        )?;
        fs::write(
            logs_dir.join(format_log_name(NodePath::root_child(2), 1, StreamKind::Stdout)),
            "two\n",
        )?;
        fs::write(
            logs_dir.join(format_log_name(
                NodePath::root_child(1).child(10),
                1,
                StreamKind::Stdout,
            )),
            "one-ten\n",
        )?;
        fs::write(
            logs_dir.join(format_log_name(NodePath::root_child(1).child(2), 1, StreamKind::Stdout)),
            "one-two\n",
        )?;

        let output = RunStore::new(&project_root)
            .logs(&run_id, LogSelection { node: None, stream: LogStream::Stdout })?;

        let headers = output.lines().filter(|line| line.starts_with("== ")).collect::<Vec<_>>();
        assert_eq!(
            headers,
            vec![
                &format!(
                    "== {} ==",
                    format_log_name(NodePath::root_child(1).child(2), 1, StreamKind::Stdout)
                ),
                &format!(
                    "== {} ==",
                    format_log_name(NodePath::root_child(1).child(10), 1, StreamKind::Stdout)
                ),
                &format!(
                    "== {} ==",
                    format_log_name(NodePath::root_child(2), 1, StreamKind::Stdout)
                ),
                &format!(
                    "== {} ==",
                    format_log_name(NodePath::root_child(10), 1, StreamKind::Stdout)
                ),
            ]
        );
        Ok(())
    }

    #[test]
    fn logs_sort_loop_iteration_frames_numerically() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("log-loop-frame-order");
        let run_id: RunId = "019cc300-0000-7000-8000-000000000007".parse()?;
        let logs_dir =
            project_root.join(".rigg").join("runs").join(run_id.to_string()).join("logs");
        fs::create_dir_all(&logs_dir)?;
        let loop_path = NodePath::root_child(0);
        let loop_scope = FrameId::root().child_loop_scope(&loop_path);
        let frame_iter_2 = FrameId::for_loop_iteration(&loop_scope, 2);
        let frame_iter_10 = FrameId::for_loop_iteration(&loop_scope, 10);
        let node_path = loop_path.child(0);

        fs::write(
            logs_dir.join(format_log_name_with_frame(
                &frame_iter_10,
                node_path.clone(),
                1,
                StreamKind::Stdout,
            )),
            "iter-10\n",
        )?;
        fs::write(
            logs_dir.join(format_log_name_with_frame(
                &frame_iter_2,
                node_path.clone(),
                1,
                StreamKind::Stdout,
            )),
            "iter-2\n",
        )?;

        let output = RunStore::new(&project_root).logs(
            &run_id,
            LogSelection { node: Some(node_path.to_string()), stream: LogStream::Stdout },
        )?;

        let headers = output.lines().filter(|line| line.starts_with("== ")).collect::<Vec<_>>();
        assert_eq!(
            headers,
            vec![
                &format!(
                    "== {} ==",
                    format_log_name_with_frame(
                        &frame_iter_2,
                        node_path.clone(),
                        1,
                        StreamKind::Stdout
                    )
                ),
                &format!(
                    "== {} ==",
                    format_log_name_with_frame(&frame_iter_10, node_path, 1, StreamKind::Stdout)
                ),
            ]
        );
        Ok(())
    }

    #[test]
    fn returns_typed_run_not_found() -> Result<(), Box<dyn std::error::Error>> {
        let project_root = temp_project_root("run-not-found");
        let run_id: RunId = "019cc300-0000-7000-8000-000000000004".parse()?;
        let error = RunStore::new(&project_root)
            .logs(&run_id, LogSelection { node: None, stream: LogStream::Stdout })
            .expect_err("missing run should error");

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
        snapshot_json_with_nodes(run_id, serde_json::json!([]))
    }

    fn snapshot_json_with_nodes(run_id: &str, nodes: serde_json::Value) -> String {
        serde_json::json!({
            "run_id": run_id,
            "workflow_id": "plan",
            "status": "succeeded",
            "reason": "completed",
            "started_at": "2026-01-01T00:00:00Z",
            "finished_at": "2026-01-01T00:00:01Z",
            "nodes": nodes
        })
        .to_string()
    }

    fn write_snapshot(
        project_root: &Path,
        run_id: &RunId,
        nodes: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let run_dir = project_root.join(".rigg").join("runs").join(run_id.to_string());
        fs::create_dir_all(&run_dir)?;
        fs::write(run_dir.join("state.json"), snapshot_json_with_nodes(run_id.as_str(), nodes))?;
        Ok(())
    }

    fn format_log_name(node_path: NodePath, attempt: u32, stream: StreamKind) -> String {
        format_log_name_with_frame(&FrameId::root(), node_path, attempt, stream)
    }

    fn format_log_name_with_frame(
        frame_id: &FrameId,
        node_path: NodePath,
        attempt: u32,
        stream: StreamKind,
    ) -> String {
        store::format_log_path(frame_id, &node_path, attempt, stream)
            .trim_start_matches("logs/")
            .to_owned()
    }
}
