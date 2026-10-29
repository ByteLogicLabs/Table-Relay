//! Tool definitions exposed to the model + the Rust-side dispatcher that
//! executes them.
//!
//! Protocol: OpenAI-compatible `tools` / `tool_calls`. Works out of the box
//! for OpenAI proper, `llama-server`, Ollama, Groq, LM Studio — any backend
//! that speaks `/v1/chat/completions` with `tool_choice: auto`. Anthropic +
//! Gemini have their own tool-use shapes; they fall back to plain chat
//! (context-only) in v1.
//!
//! Approval model: `list_schemas`, `list_tables`, `describe_table` run
//! silently — they expose shapes only, never rows. `call_sql` is gated
//! behind an async approval round-trip with the UI so the user sees the
//! SQL before it executes.
//!
//! This module is split into focused submodules; everything that other parts
//! of the crate reference via `crate::ai::tools::*` is re-exported here so the
//! public path stays identical.

mod approval;
mod catalog;
mod dispatch;
mod tiers;

pub use approval::{ApprovalDecision, ApprovalRegistry, AutoApprovalFlags, AutoApprovals};
pub use catalog::{catalog_scoped, ToolDef};
// `ToolFunction` is public API (it's the type of `ToolDef::function`) but is
// never named directly outside this module; allow the unused-import lint on
// the re-export so the public path stays identical.
#[allow(unused_imports)]
pub use catalog::ToolFunction;
pub use dispatch::{dispatch, ToolContext, ToolResult};
// `classify_*`, `QueryTier`, and `ToolFunction` were `pub` in the original
// single-file module and are part of this module's public API, but have no
// in-crate consumers — re-exporting them as a private submodule's items
// trips the unused-import lint. Allow it so the public surface stays identical
// to the pre-split `pub mod tools` without introducing a new warning.
#[allow(unused_imports)]
pub use tiers::{classify_batch, classify_sql, QueryTier};
