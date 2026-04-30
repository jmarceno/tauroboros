use crate::error::ApiError;
use crate::models::{Task, WorkflowRun};

pub trait TaskJsonExt {
    fn requirements_vec(&self) -> Vec<String>;
}

impl TaskJsonExt for Task {
    fn requirements_vec(&self) -> Vec<String> {
        match self.requirements.as_deref() {
            Some(raw) => match serde_json::from_str::<Vec<String>>(raw) {
                Ok(vec) => vec,
                Err(e) => {
                    tracing::error!(
                        task_id = %self.id,
                        requirements_json = %raw,
                        error = %e,
                        "Failed to parse task requirements JSON - returning empty requirements"
                    );
                    Vec::new()
                }
            },
            None => Vec::new(),
        }
    }
}

pub trait RunJsonExt {
    fn task_order_vec(&self) -> Result<Vec<String>, ApiError>;
}

impl RunJsonExt for WorkflowRun {
    fn task_order_vec(&self) -> Result<Vec<String>, ApiError> {
        match self.task_order.as_deref() {
            Some(raw) => serde_json::from_str::<Vec<String>>(raw).map_err(ApiError::Serialization),
            None => Ok(Vec::new()),
        }
    }
}
