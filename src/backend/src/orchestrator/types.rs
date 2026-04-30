use crate::models::{TaskStatus, WorkflowRun};
use tokio::sync::watch;

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct SlotAssignment {
    pub run_id: String,
    pub task_id: String,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) struct ActiveTaskControl {
    pub run_id: String,
    pub slot_index: usize,
    pub stop_tx: watch::Sender<bool>,
}

#[derive(Debug, Default)]
pub(crate) struct RuntimeState {
    pub active_run_id: Option<String>,
    pub slots: Vec<Option<SlotAssignment>>,
    pub active_tasks: std::collections::HashMap<String, ActiveTaskControl>,
}

#[derive(Debug, Clone)]
pub struct RunStopResult {
    pub run: WorkflowRun,
    pub killed: i32,
    pub cleaned: i32,
}

pub(super) const GRACEFUL_STOP_MESSAGE: &str = "Workflow stopped by user";
pub(super) const DESTRUCTIVE_STOP_MESSAGE: &str = "Workflow stopped by user - all work discarded";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopMode {
    Graceful,
    Destructive,
    Failure,
}

pub(crate) fn stop_mode_for_run(run: &WorkflowRun) -> Option<StopMode> {
    if !run.stop_requested {
        return None;
    }

    match run.error_message.as_deref() {
        Some(GRACEFUL_STOP_MESSAGE) => Some(StopMode::Graceful),
        Some(DESTRUCTIVE_STOP_MESSAGE) => Some(StopMode::Destructive),
        _ => Some(StopMode::Failure),
    }
}

#[derive(Debug, Clone)]
pub struct TaskOutcome {
    pub status: TaskStatus,
    pub error_message: Option<String>,
}
