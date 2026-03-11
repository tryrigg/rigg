use crate::store;
use crate::{EventRecord, Meta, RunSnapshot};
use rigg_core::{FrameId, NodePath, RunEventRecord, RunMeta, RunState, StreamKind};
use rigg_engine::{EngineError, RecorderError, RunRecorder};
use serde_json::to_string;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

impl crate::store::FsRunRecorder {
    fn ensure_run_dir(&self) -> Result<&Path, EngineError> {
        self.run_dir
            .as_deref()
            .ok_or(EngineError::Recorder(RecorderError::RunDirectoryNotInitialized))
    }

    fn prepare_run_dir(run_dir: &Path) -> Result<(), EngineError> {
        fs::create_dir_all(run_dir.join("logs")).map_err(|source| {
            EngineError::Recorder(RecorderError::CreateDirectory {
                path: run_dir.join("logs"),
                source,
            })
        })?;
        Ok(())
    }

    fn activate_run_dir(&mut self, run_id: &rigg_core::RunId) -> std::path::PathBuf {
        let run_dir = store::run_dir(&self.project_root, run_id);
        self.events_path = Some(store::events_path(&run_dir));
        self.run_dir = Some(run_dir.clone());
        run_dir
    }

    fn persist_meta(&self, run_dir: &Path, meta: &RunMeta) -> Result<(), EngineError> {
        let meta_path = store::meta_path(run_dir);
        let protocol_meta = Meta::from(meta);
        fs::write(&meta_path, serde_json::to_vec_pretty(&protocol_meta).map_err(json_store_error)?)
            .map_err(|source| {
                EngineError::Recorder(RecorderError::WriteFile { path: meta_path.clone(), source })
            })
    }

    fn persist_state(&self, run_dir: &Path, state: &RunState) -> Result<(), EngineError> {
        let state_path = store::state_path(run_dir);
        let temp_path = store::temp_state_path(run_dir);
        fs::write(
            &temp_path,
            serde_json::to_vec_pretty(&RunSnapshot::from(state)).map_err(json_store_error)?,
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
}

impl RunRecorder for crate::store::FsRunRecorder {
    fn init_run(&mut self, state: &RunState, meta: &RunMeta) -> Result<(), EngineError> {
        let run_dir = store::run_dir(&self.project_root, &meta.run_id);
        let staging_dir = store::staging_run_dir(&self.project_root, &meta.run_id);
        Self::prepare_run_dir(&staging_dir)?;

        let init_result = (|| {
            self.persist_state(&staging_dir, state)?;
            self.persist_meta(&staging_dir, meta)?;
            fs::rename(&staging_dir, &run_dir).map_err(|source| {
                EngineError::Recorder(RecorderError::ReplaceFile {
                    from: staging_dir.clone(),
                    to: run_dir.clone(),
                    source,
                })
            })
        })();

        if init_result.is_err() {
            let _ = fs::remove_dir_all(&staging_dir);
            return init_result;
        }

        self.activate_run_dir(&meta.run_id);
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
        let protocol_event = EventRecord::from(event);
        writeln!(file, "{}", to_string(&protocol_event).map_err(json_store_error)?)
            .map_err(|source| EngineError::Recorder(RecorderError::AppendFile { path, source }))
    }

    fn write_state(&mut self, state: &RunState) -> Result<(), EngineError> {
        let run_dir = if let Some(run_dir) = self.run_dir.clone() {
            run_dir
        } else {
            let run_dir = store::run_dir(&self.project_root, &state.run_id);
            Self::prepare_run_dir(&run_dir)?;
            self.activate_run_dir(&state.run_id)
        };
        self.persist_state(&run_dir, state)
    }

    fn run_artifacts_dir(&self) -> Result<std::path::PathBuf, EngineError> {
        Ok(store::artifacts_dir(self.ensure_run_dir()?))
    }

    fn log_path(
        &self,
        frame_id: &FrameId,
        node_path: &NodePath,
        attempt: u32,
        stream: StreamKind,
    ) -> String {
        store::format_log_path(frame_id, node_path, attempt, stream)
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

fn json_store_error(error: serde_json::Error) -> EngineError {
    EngineError::Recorder(RecorderError::SerializeJson {
        operation: "store payload",
        source: error,
    })
}
