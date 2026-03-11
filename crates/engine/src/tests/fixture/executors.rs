use super::{lock, request_key, successful_text_step};
use crate::conversation::ConversationProvider;
use crate::progress::{ProviderEvent, StepProgressSink};
use crate::{EngineError, ExecutorError, StepRunRequest, StepRunResult, StepRunner};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration as StdDuration;

#[derive(Debug)]
pub(crate) struct FakeExecutor {
    responses: Mutex<VecDeque<StepRunResult>>,
}

impl FakeExecutor {
    pub(crate) fn new(responses: Vec<StepRunResult>) -> Self {
        Self { responses: Mutex::new(VecDeque::from(responses)) }
    }
}

impl StepRunner for FakeExecutor {
    fn run_step(
        &self,
        _request: &StepRunRequest,
        _progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        lock(&self.responses).pop_front().ok_or_else(|| {
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

#[derive(Debug)]
pub(crate) struct StaticExecutor {
    result: Mutex<Option<Result<StepRunResult, EngineError>>>,
}

impl StaticExecutor {
    pub(crate) fn new(result: Result<StepRunResult, EngineError>) -> Self {
        Self { result: Mutex::new(Some(result)) }
    }
}

impl StepRunner for StaticExecutor {
    fn run_step(
        &self,
        _request: &StepRunRequest,
        _progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        lock(&self.result).take().unwrap_or_else(|| {
            Err(EngineError::Executor(ExecutorError::RunTool {
                program: "static-executor".to_owned(),
                source: std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "missing static result",
                ),
            }))
        })
    }
}

#[derive(Debug)]
pub(crate) struct RecordingExecutor {
    responses: Mutex<VecDeque<StepRunResult>>,
    pub(crate) requests: Mutex<Vec<StepRunRequest>>,
}

impl RecordingExecutor {
    pub(crate) fn new(responses: Vec<StepRunResult>) -> Self {
        Self { responses: Mutex::new(VecDeque::from(responses)), requests: Mutex::new(Vec::new()) }
    }
}

impl StepRunner for RecordingExecutor {
    fn run_step(
        &self,
        request: &StepRunRequest,
        _progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        lock(&self.requests).push(request.clone());
        lock(&self.responses).pop_front().ok_or_else(|| {
            EngineError::Executor(ExecutorError::RunTool {
                program: "recording-executor".to_owned(),
                source: std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "missing fake response",
                ),
            })
        })
    }
}

#[derive(Debug)]
pub(crate) struct MappedExecutor {
    responses: Mutex<BTreeMap<String, VecDeque<StepRunResult>>>,
    pub(crate) requests: Mutex<Vec<StepRunRequest>>,
}

impl MappedExecutor {
    pub(crate) fn new(responses: Vec<(&str, StepRunResult)>) -> Self {
        let mut mapped = BTreeMap::<String, VecDeque<StepRunResult>>::new();
        for (key, response) in responses {
            mapped.entry(key.to_owned()).or_default().push_back(response);
        }
        Self { responses: Mutex::new(mapped), requests: Mutex::new(Vec::new()) }
    }
}

impl StepRunner for MappedExecutor {
    fn run_step(
        &self,
        request: &StepRunRequest,
        _progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        lock(&self.requests).push(request.clone());
        let key = request_key(request);
        lock(&self.responses).get_mut(&key).and_then(VecDeque::pop_front).ok_or_else(|| {
            EngineError::Executor(ExecutorError::RunTool {
                program: format!("mapped-executor:{key}"),
                source: std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "missing mapped response",
                ),
            })
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct BlockingGate {
    released: Mutex<bool>,
    ready: Condvar,
}

impl BlockingGate {
    pub(crate) fn wait(&self) {
        let (guard, timeout) = self
            .ready
            .wait_timeout_while(lock(&self.released), StdDuration::from_millis(300), |released| {
                !*released
            })
            .expect("condvar wait should not be poisoned");
        if timeout.timed_out() && !*guard {
            panic!("gate was not released before timeout elapsed");
        }
    }

    pub(crate) fn release(&self) {
        *lock(&self.released) = true;
        self.ready.notify_all();
    }
}

#[derive(Debug, Default)]
pub(crate) struct ProgressModeExecutor {
    pub(crate) seen_progress_modes: Mutex<Vec<bool>>,
}

impl StepRunner for ProgressModeExecutor {
    fn run_step(
        &self,
        _request: &StepRunRequest,
        progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        lock(&self.seen_progress_modes).push(progress.is_enabled());
        Ok(successful_text_step("ok"))
    }
}

#[derive(Debug, Default)]
pub(crate) struct ConcurrentGateExecutor {
    state: Mutex<ConcurrentGateState>,
    ready: Condvar,
}

#[derive(Debug, Default)]
struct ConcurrentGateState {
    entered: usize,
    released: bool,
}

impl StepRunner for ConcurrentGateExecutor {
    fn run_step(
        &self,
        _request: &StepRunRequest,
        _progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        let mut state = lock(&self.state);
        state.entered += 1;
        if state.entered == 2 {
            state.released = true;
            self.ready.notify_all();
        } else {
            let (guard, timeout) = self
                .ready
                .wait_timeout_while(state, StdDuration::from_millis(300), |state| !state.released)
                .expect("condvar wait should not be poisoned");
            state = guard;
            if timeout.timed_out() {
                return Err(EngineError::Executor(ExecutorError::RunTool {
                    program: "concurrent-gate".to_owned(),
                    source: std::io::Error::other(
                        "parallel branch did not start before timeout elapsed",
                    ),
                }));
            }
        }
        drop(state);
        Ok(successful_text_step("ok"))
    }
}

#[derive(Debug, Default)]
pub(crate) struct SnapshottingParallelExecutor;

impl StepRunner for SnapshottingParallelExecutor {
    fn run_step(
        &self,
        request: &StepRunRequest,
        _progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        let command = match request {
            StepRunRequest::Shell(request) => request.command.as_str(),
            other => panic!("unexpected request: {other:?}"),
        };
        if command == "printf slow" {
            std::thread::sleep(StdDuration::from_millis(120));
        } else {
            std::thread::sleep(StdDuration::from_millis(10));
        }
        Ok(successful_text_step(command))
    }
}

#[derive(Debug)]
pub(crate) struct LiveProgressParallelExecutor {
    pub(crate) gate: Arc<BlockingGate>,
}

impl StepRunner for LiveProgressParallelExecutor {
    fn run_step(
        &self,
        request: &StepRunRequest,
        progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        let command = match request {
            StepRunRequest::Shell(request) => request.command.as_str(),
            other => panic!("unexpected request: {other:?}"),
        };
        match command {
            "printf fast" => {
                progress.provider_event(ProviderEvent::Status {
                    provider: ConversationProvider::Codex,
                    message: "fast-live".to_owned(),
                });
                Ok(successful_text_step("fast"))
            }
            "printf slow" => {
                self.gate.wait();
                Ok(successful_text_step("slow"))
            }
            other => panic!("unexpected command: {other}"),
        }
    }
}

#[derive(Debug)]
pub(crate) struct MidBranchCheckpointExecutor {
    pub(crate) gate: Arc<BlockingGate>,
}

impl StepRunner for MidBranchCheckpointExecutor {
    fn run_step(
        &self,
        request: &StepRunRequest,
        _progress: &mut dyn StepProgressSink,
    ) -> Result<StepRunResult, EngineError> {
        let command = match request {
            StepRunRequest::Shell(request) => request.command.as_str(),
            other => panic!("unexpected request: {other:?}"),
        };
        match command {
            "printf first" => Ok(successful_text_step("first")),
            "printf second" => {
                self.gate.wait();
                Ok(successful_text_step("second"))
            }
            other => panic!("unexpected command: {other}"),
        }
    }
}
