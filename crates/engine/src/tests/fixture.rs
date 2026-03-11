use crate::{FrameId, LiveEvent, NodePath, RunState, StreamKind};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

mod builders;
mod clocks;
mod executors;
mod recorders;

type SharedProgressEvents = Arc<(Mutex<Vec<LiveEvent>>, Condvar)>;
type SharedRecordedStates = Arc<(Mutex<Vec<RunState>>, Condvar)>;

pub(super) use builders::*;
pub(super) use clocks::*;
pub(super) use executors::*;
pub(super) use recorders::*;

pub(super) fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex.lock().expect("mutex should not be poisoned")
}

pub(super) fn default_log_path(
    frame_id: &FrameId,
    node_path: &NodePath,
    attempt: u32,
    stream: StreamKind,
) -> String {
    let suffix = match stream {
        StreamKind::Stdout => "stdout",
        StreamKind::Stderr => "stderr",
    };
    format!(
        "frame={frame_id}.path={}.attempt-{}.{}.log",
        node_path.file_component(),
        attempt,
        suffix
    )
}
