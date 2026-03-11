use super::{SharedProgressEvents, SharedRecordedStates, default_log_path, lock};
use crate::progress::ProgressSink;
use crate::{
    EngineError, FrameId, LiveEvent, NodePath, RunEventRecord, RunMeta, RunRecorder, RunState,
    StreamKind,
};

#[derive(Debug, Default)]
pub(crate) struct MemoryRecorder;

impl RunRecorder for MemoryRecorder {
    fn init_run(&mut self, _state: &RunState, _meta: &RunMeta) -> Result<(), EngineError> {
        Ok(())
    }

    fn append_event(&mut self, _event: &RunEventRecord) -> Result<(), EngineError> {
        Ok(())
    }

    fn write_state(&mut self, _state: &RunState) -> Result<(), EngineError> {
        Ok(())
    }

    fn run_artifacts_dir(&self) -> Result<std::path::PathBuf, EngineError> {
        Ok(std::env::temp_dir())
    }

    fn log_path(
        &self,
        frame_id: &FrameId,
        node_path: &NodePath,
        attempt: u32,
        stream: StreamKind,
    ) -> String {
        default_log_path(frame_id, node_path, attempt, stream)
    }

    fn append_log(&mut self, _path: &str, _chunk: &str) -> Result<(), EngineError> {
        Ok(())
    }
}

#[derive(Debug, Default)]
pub(crate) struct TraceRecorder {
    pub(crate) states: Vec<RunState>,
    pub(crate) events: Vec<RunEventRecord>,
}

impl RunRecorder for TraceRecorder {
    fn init_run(&mut self, state: &RunState, _meta: &RunMeta) -> Result<(), EngineError> {
        self.states.push(state.clone());
        Ok(())
    }

    fn append_event(&mut self, event: &RunEventRecord) -> Result<(), EngineError> {
        self.events.push(event.clone());
        Ok(())
    }

    fn write_state(&mut self, state: &RunState) -> Result<(), EngineError> {
        self.states.push(state.clone());
        Ok(())
    }

    fn run_artifacts_dir(&self) -> Result<std::path::PathBuf, EngineError> {
        Ok(std::env::temp_dir())
    }

    fn log_path(
        &self,
        frame_id: &FrameId,
        node_path: &NodePath,
        attempt: u32,
        stream: StreamKind,
    ) -> String {
        default_log_path(frame_id, node_path, attempt, stream)
    }

    fn append_log(&mut self, _path: &str, _chunk: &str) -> Result<(), EngineError> {
        Ok(())
    }
}

#[derive(Debug, Default)]
pub(crate) struct CustomLogPathRecorder {
    pub(crate) events: Vec<RunEventRecord>,
    pub(crate) logs: Vec<(String, String)>,
}

impl RunRecorder for CustomLogPathRecorder {
    fn init_run(&mut self, _state: &RunState, _meta: &RunMeta) -> Result<(), EngineError> {
        Ok(())
    }

    fn append_event(&mut self, event: &RunEventRecord) -> Result<(), EngineError> {
        self.events.push(event.clone());
        Ok(())
    }

    fn write_state(&mut self, _state: &RunState) -> Result<(), EngineError> {
        Ok(())
    }

    fn run_artifacts_dir(&self) -> Result<std::path::PathBuf, EngineError> {
        Ok(std::env::temp_dir())
    }

    fn log_path(
        &self,
        frame_id: &FrameId,
        node_path: &NodePath,
        attempt: u32,
        stream: StreamKind,
    ) -> String {
        format!("custom/{}", default_log_path(frame_id, node_path, attempt, stream))
    }

    fn append_log(&mut self, path: &str, chunk: &str) -> Result<(), EngineError> {
        self.logs.push((path.to_owned(), chunk.to_owned()));
        Ok(())
    }
}

#[derive(Debug, Default)]
pub(crate) struct TraceProgress {
    pub(crate) events: Vec<LiveEvent>,
}

impl ProgressSink for TraceProgress {
    fn is_enabled(&self) -> bool {
        true
    }

    fn emit(&mut self, event: LiveEvent) {
        self.events.push(event);
    }
}

#[derive(Debug)]
pub(crate) struct SharedTraceProgress {
    shared: SharedProgressEvents,
}

impl SharedTraceProgress {
    pub(crate) fn new() -> (Self, SharedProgressEvents) {
        let shared =
            std::sync::Arc::new((std::sync::Mutex::new(Vec::new()), std::sync::Condvar::new()));
        (Self { shared: shared.clone() }, shared)
    }
}

impl ProgressSink for SharedTraceProgress {
    fn is_enabled(&self) -> bool {
        true
    }

    fn emit(&mut self, event: LiveEvent) {
        let (events, ready) = &*self.shared;
        lock(events).push(event);
        ready.notify_all();
    }
}

#[derive(Debug)]
pub(crate) struct SharedStateRecorder {
    shared: SharedRecordedStates,
}

impl SharedStateRecorder {
    pub(crate) fn new() -> (Self, SharedRecordedStates) {
        let shared =
            std::sync::Arc::new((std::sync::Mutex::new(Vec::new()), std::sync::Condvar::new()));
        (Self { shared: shared.clone() }, shared)
    }
}

impl RunRecorder for SharedStateRecorder {
    fn init_run(&mut self, state: &RunState, _meta: &RunMeta) -> Result<(), EngineError> {
        let (states, ready) = &*self.shared;
        lock(states).push(state.clone());
        ready.notify_all();
        Ok(())
    }

    fn append_event(&mut self, _event: &RunEventRecord) -> Result<(), EngineError> {
        Ok(())
    }

    fn write_state(&mut self, state: &RunState) -> Result<(), EngineError> {
        let (states, ready) = &*self.shared;
        lock(states).push(state.clone());
        ready.notify_all();
        Ok(())
    }

    fn run_artifacts_dir(&self) -> Result<std::path::PathBuf, EngineError> {
        Ok(std::env::temp_dir())
    }

    fn log_path(
        &self,
        frame_id: &FrameId,
        node_path: &NodePath,
        attempt: u32,
        stream: StreamKind,
    ) -> String {
        default_log_path(frame_id, node_path, attempt, stream)
    }

    fn append_log(&mut self, _path: &str, _chunk: &str) -> Result<(), EngineError> {
        Ok(())
    }
}
