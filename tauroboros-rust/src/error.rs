use rocket::http::Status;
use rocket::serde::json::{json, Value};
use rocket::response::{self, Responder, Response};
use rocket::Request;
use thiserror::Error;

/// Error codes matching the TypeScript ErrorCode enum
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ErrorCode {
    // General errors
    Unknown = 1000,
    InternalServerError = 1001,
    ServiceUnavailable = 1002,
    InvalidJsonBody = 1003,
    InvalidRequestBody = 1004,
    
    // Task errors
    TaskNotFound = 2000,
    TaskAlreadyExists = 2001,
    TaskBlocked = 2002,
    TaskAlreadyExecuting = 2003,
    InvalidTaskCreationInput = 2004,
    
    // Run errors
    RunNotFound = 3000,
    RunAlreadyExists = 3001,
    ExecutionOperationFailed = 3002,
    
    // Session errors
    SessionNotFound = 4000,
    SessionAlreadyExists = 4001,
    
    // Task group errors
    TaskGroupNotFound = 5000,
    TaskAlreadyInGroup = 5001,
    
    // Planning errors
    PlanningPromptNotConfigured = 6000,
    PlanningSessionCreateFailed = 6001,
    PlanningSessionNotActive = 6002,
    PlanningSessionReconnectFailed = 6003,
    PlanningSessionStopFailed = 6004,
    PlanningSessionCloseFailed = 6005,
    NotAPlanningSession = 6006,
    MessageSendFailed = 6007,
    
    // Validation errors
    InvalidModel = 7000,
    InvalidThinkingLevel = 7001,
    InvalidExecutionStrategy = 7002,
    InvalidColor = 7003,
    InvalidTaskGroupStatus = 7004,
    
    // Container errors (kept for compatibility but not used)
    ContainerOperationFailed = 8000,
    ProfileNotFound = 8001,
    
    // External dependency errors
    ExternalDependenciesBlocked = 9000,
    InvalidContainerImages = 9001,
    ContainerImageNotFound = 9002,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::Unknown => "UNKNOWN",
            ErrorCode::InternalServerError => "INTERNAL_SERVER_ERROR",
            ErrorCode::ServiceUnavailable => "SERVICE_UNAVAILABLE",
            ErrorCode::InvalidJsonBody => "INVALID_JSON_BODY",
            ErrorCode::InvalidRequestBody => "INVALID_REQUEST_BODY",
            ErrorCode::TaskNotFound => "TASK_NOT_FOUND",
            ErrorCode::TaskAlreadyExists => "TASK_ALREADY_EXISTS",
            ErrorCode::TaskBlocked => "TASK_BLOCKED",
            ErrorCode::TaskAlreadyExecuting => "TASK_ALREADY_EXECUTING",
            ErrorCode::InvalidTaskCreationInput => "INVALID_TASK_CREATION_INPUT",
            ErrorCode::RunNotFound => "RUN_NOT_FOUND",
            ErrorCode::RunAlreadyExists => "RUN_ALREADY_EXISTS",
            ErrorCode::ExecutionOperationFailed => "EXECUTION_OPERATION_FAILED",
            ErrorCode::SessionNotFound => "SESSION_NOT_FOUND",
            ErrorCode::SessionAlreadyExists => "SESSION_ALREADY_EXISTS",
            ErrorCode::TaskGroupNotFound => "TASK_GROUP_NOT_FOUND",
            ErrorCode::TaskAlreadyInGroup => "TASK_ALREADY_IN_GROUP",
            ErrorCode::PlanningPromptNotConfigured => "PLANNING_PROMPT_NOT_CONFIGURED",
            ErrorCode::PlanningSessionCreateFailed => "PLANNING_SESSION_CREATE_FAILED",
            ErrorCode::PlanningSessionNotActive => "PLANNING_SESSION_NOT_ACTIVE",
            ErrorCode::PlanningSessionReconnectFailed => "PLANNING_SESSION_RECONNECT_FAILED",
            ErrorCode::PlanningSessionStopFailed => "PLANNING_SESSION_STOP_FAILED",
            ErrorCode::PlanningSessionCloseFailed => "PLANNING_SESSION_CLOSE_FAILED",
            ErrorCode::NotAPlanningSession => "NOT_A_PLANNING_SESSION",
            ErrorCode::MessageSendFailed => "MESSAGE_SEND_FAILED",
            ErrorCode::InvalidModel => "INVALID_MODEL",
            ErrorCode::InvalidThinkingLevel => "INVALID_THINKING_LEVEL",
            ErrorCode::InvalidExecutionStrategy => "INVALID_EXECUTION_STRATEGY",
            ErrorCode::InvalidColor => "INVALID_COLOR",
            ErrorCode::InvalidTaskGroupStatus => "INVALID_TASK_GROUP_STATUS",
            ErrorCode::ContainerOperationFailed => "CONTAINER_OPERATION_FAILED",
            ErrorCode::ProfileNotFound => "PROFILE_NOT_FOUND",
            ErrorCode::ExternalDependenciesBlocked => "EXTERNAL_DEPENDENCIES_BLOCKED",
            ErrorCode::InvalidContainerImages => "INVALID_CONTAINER_IMAGES",
            ErrorCode::ContainerImageNotFound => "CONTAINER_IMAGE_NOT_FOUND",
        }
    }
}

#[derive(Error, Debug)]
pub enum ApiError {
    #[error("{message}")]
    BadRequest {
        message: String,
        code: ErrorCode,
    },
    
    #[error("{message}")]
    NotFound {
        message: String,
        code: ErrorCode,
    },
    
    #[error("{message}")]
    Conflict {
        message: String,
        code: ErrorCode,
    },
    
    #[error("{message}")]
    InternalError {
        message: String,
        code: ErrorCode,
        #[source]
        cause: Option<Box<dyn std::error::Error + Send + Sync>>,
    },
    
    #[error("Service unavailable: {message}")]
    #[allow(dead_code)]
    ServiceUnavailable {
        message: String,
        code: ErrorCode,
    },
    
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        ApiError::BadRequest {
            message: message.into(),
            code: ErrorCode::InvalidRequestBody,
        }
    }
    
    pub fn not_found(message: impl Into<String>) -> Self {
        ApiError::NotFound {
            message: message.into(),
            code: ErrorCode::Unknown,
        }
    }
    
    pub fn conflict(message: impl Into<String>) -> Self {
        ApiError::Conflict {
            message: message.into(),
            code: ErrorCode::Unknown,
        }
    }
    
    pub fn internal(message: impl Into<String>) -> Self {
        ApiError::InternalError {
            message: message.into(),
            code: ErrorCode::InternalServerError,
            cause: None,
        }
    }
    
    pub fn with_code(mut self, code: ErrorCode) -> Self {
        match &mut self {
            ApiError::BadRequest { code: c, .. } => *c = code,
            ApiError::NotFound { code: c, .. } => *c = code,
            ApiError::Conflict { code: c, .. } => *c = code,
            ApiError::InternalError { code: c, .. } => *c = code,
            ApiError::ServiceUnavailable { code: c, .. } => *c = code,
            _ => {}
        }
        self
    }
    
    fn status_code(&self) -> Status {
        match self {
            ApiError::BadRequest { .. } => Status::BadRequest,
            ApiError::NotFound { .. } => Status::NotFound,
            ApiError::Conflict { .. } => Status::Conflict,
            ApiError::InternalError { .. } => Status::InternalServerError,
            ApiError::ServiceUnavailable { .. } => Status::ServiceUnavailable,
            ApiError::Database(_) => Status::InternalServerError,
            ApiError::Serialization(_) => Status::BadRequest,
        }
    }
    
    fn to_json(&self) -> Value {
        let (message, code) = match self {
            ApiError::BadRequest { message, code } => (message.clone(), *code),
            ApiError::NotFound { message, code } => (message.clone(), *code),
            ApiError::Conflict { message, code } => (message.clone(), *code),
            ApiError::InternalError { message, code, .. } => (message.clone(), *code),
            ApiError::ServiceUnavailable { message, code } => (message.clone(), *code),
            ApiError::Database(e) => (e.to_string(), ErrorCode::InternalServerError),
            ApiError::Serialization(e) => (e.to_string(), ErrorCode::InvalidJsonBody),
        };
        
        json!({
            "error": message,
            "code": code.as_str(),
        })
    }
}

impl<'r> Responder<'r, 'static> for ApiError {
    fn respond_to(self, req: &'r Request<'_>) -> response::Result<'static> {
        let status = self.status_code();
        let json = self.to_json();
        
        Response::build_from(json.respond_to(req)?)
            .status(status)
            .header(rocket::http::ContentType::JSON)
            .ok()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
