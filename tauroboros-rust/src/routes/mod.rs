use rocket::Route;

pub mod tasks;
pub mod sessions;
pub mod task_groups;
pub mod planning;
pub mod workflow;
pub mod options;
pub mod runs;
pub mod stats;
pub mod prompts;
pub mod sse;
pub mod execution;
pub mod archived;
pub mod reference;
pub mod containers;
pub mod frontend;

/// Collect all routes
pub fn routes() -> Vec<Route> {
    let mut routes = Vec::new();
    
    // Task routes
    routes.extend(tasks::routes());
    
    // Session routes
    routes.extend(sessions::routes());
    
    // Task group routes
    routes.extend(task_groups::routes());
    
    // Planning routes
    routes.extend(planning::routes());
    
    // Workflow routes
    routes.extend(workflow::routes());
    
    // Options routes
    routes.extend(options::routes());
    
    // Run routes
    routes.extend(runs::routes());
    
    // Stats routes
    routes.extend(stats::routes());
    
    // Prompt routes
    routes.extend(prompts::routes());
    
    // SSE routes
    routes.extend(sse::routes());
    
    // Execution routes
    routes.extend(execution::routes());
    
    // Archived routes
    routes.extend(archived::routes());
    
    // Reference routes (models, version, branches)
    routes.extend(reference::routes());
    
    // Container routes
    routes.extend(containers::routes());

    // Frontend routes
    routes.extend(frontend::routes());
    
    routes
}
