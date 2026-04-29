//! Prompt Catalog - single source of truth for all prompts
//!
//! This module loads prompts from the shared `prompt-catalog.json` file
//! at compile time via `include_str!`. Both the Rust backend and Solid JS
//! frontend derive their prompts from this file. Modify this file to change
//! any prompt text.
//!
//! The JSON file is located at `src/backend/prompts/prompt-catalog.json`
//! and is the authoritative source for all system prompts and prompt templates.

use serde::Deserialize;
use std::collections::HashMap;

/// Top-level structure of the prompt catalog JSON.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCatalog {
    /// Line-based prompts (used for backward compatibility / frontend defaults)
    #[serde(default)]
    #[allow(dead_code)]
    pub default_commit_prompt_lines: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub default_code_style_prompt_lines: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub resume_task_continuation_prompt_lines: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub merge_conflict_repair_prompt_lines: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub task_setup_prompt_lines: Vec<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub mock_classification_prompt_lines: Vec<String>,
    /// Template-based prompts (seeded into prompt_templates table)
    #[serde(default)]
    pub templates: HashMap<String, PromptTemplateDef>,
    /// System prompts (seeded into planning_prompts table)
    #[serde(default)]
    pub system_prompts: HashMap<String, SystemPromptDef>,
}

/// A single prompt template definition from the catalog.
#[derive(Debug, Deserialize, Clone)]
pub struct PromptTemplateDef {
    pub key: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "templateText")]
    pub template_text: Vec<String>,
    pub variables: Vec<String>,
}

/// A single system prompt definition from the catalog.
#[derive(Debug, Deserialize, Clone)]
pub struct SystemPromptDef {
    pub key: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "promptText")]
    pub prompt_text: Vec<String>,
}

/// Load the prompt catalog from the embedded JSON at compile time.
fn load_catalog() -> PromptCatalog {
    let json_str = include_str!("../prompts/prompt-catalog.json");
    serde_json::from_str::<PromptCatalog>(json_str).expect("Failed to parse prompt-catalog.json")
}

/// Get all prompt templates as a vector of (key, name, description, template_text, variables_json).
pub fn get_all_templates() -> Vec<(String, String, String, String, String)> {
    let catalog = load_catalog();
    catalog
        .templates
        .into_values()
        .map(|t| {
            let template_text = t.template_text.join("\n");
            let variables_json =
                serde_json::to_string(&t.variables).unwrap_or_else(|_| "[]".to_string());
            (t.key, t.name, t.description, template_text, variables_json)
        })
        .collect()
}

/// Get the "line-based" prompts joined into strings, keyed by the DB key.
///
/// These are prompts like `defaultCommitPromptLines` (mapped to key `commit`),
/// `defaultCodeStylePromptLines` (mapped to key `code_style`), etc.
/// However, the canonical templates are in the `templates` object.
/// These line-based prompts are used for specific purposes by the frontend.
#[allow(dead_code)]
pub fn get_line_prompts() -> HashMap<String, String> {
    let catalog = load_catalog();
    let mut map = HashMap::new();
    map.insert(
        "commit_lines".to_string(),
        catalog.default_commit_prompt_lines.join("\n"),
    );
    map.insert(
        "code_style_lines".to_string(),
        catalog.default_code_style_prompt_lines.join("\n"),
    );
    map.insert(
        "resume_task_continuation_lines".to_string(),
        catalog.resume_task_continuation_prompt_lines.join("\n"),
    );
    map.insert(
        "merge_conflict_repair_lines".to_string(),
        catalog.merge_conflict_repair_prompt_lines.join("\n"),
    );
    map.insert(
        "task_setup_lines".to_string(),
        catalog.task_setup_prompt_lines.join("\n"),
    );
    map.insert(
        "mock_classification_lines".to_string(),
        catalog.mock_classification_prompt_lines.join("\n"),
    );
    map
}

/// Get all system prompts (for `planning_prompts` table).
pub fn get_all_system_prompts() -> Vec<SystemPromptDef> {
    let catalog = load_catalog();
    catalog.system_prompts.into_values().collect()
}

/// Get a specific system prompt by key.
#[allow(dead_code)]
pub fn get_system_prompt(key: &str) -> Option<SystemPromptDef> {
    let catalog = load_catalog();
    catalog.system_prompts.get(key).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loads_all_templates() {
        let templates = get_all_templates();
        assert!(!templates.is_empty(), "Should have at least one template");

        let keys: Vec<&str> = templates.iter().map(|(k, _, _, _, _)| k.as_str()).collect();
        assert!(keys.contains(&"execution"), "Should contain execution template");
        assert!(keys.contains(&"planning"), "Should contain planning template");
        assert!(keys.contains(&"review"), "Should contain review template");
        assert!(keys.contains(&"commit"), "Should contain commit template");
        assert!(
            keys.contains(&"best_of_n_worker"),
            "Should contain best_of_n_worker template"
        );
    }

    #[test]
    fn test_loads_all_system_prompts() {
        let prompts = get_all_system_prompts();
        assert!(!prompts.is_empty(), "Should have at least one system prompt");

        let keys: Vec<&str> = prompts.iter().map(|p| p.key.as_str()).collect();
        assert!(keys.contains(&"planning"), "Should contain planning prompt");
        assert!(
            keys.contains(&"self_healing"),
            "Should contain self_healing prompt"
        );
    }

    #[test]
    fn test_template_text_is_joined_with_newlines() {
        let templates = get_all_templates();
        for (key, _, _, text, _) in &templates {
            assert!(
                !text.is_empty(),
                "Template '{}' should have non-empty text",
                key
            );
            assert!(
                text.contains('\n'),
                "Template '{}' text should contain newlines (was joined)",
                key
            );
        }
    }

    #[test]
    fn test_system_prompt_text_is_joined() {
        let prompt = get_system_prompt("planning");
        assert!(prompt.is_some(), "planning system prompt should exist");
        let text = prompt.unwrap().prompt_text.join("\n");
        assert!(!text.is_empty(), "planning prompt text should not be empty");
        assert!(
            text.contains("Planning Assistant"),
            "Should contain 'Planning Assistant'"
        );
    }
}
