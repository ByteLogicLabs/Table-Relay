//! Approval orchestration: the async round-trip registry that gates tool calls
//! on the user, plus the per-tool / per-tier auto-approval flag store.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Mutex};

use crate::ai::AiError;

use super::tiers::QueryTier;

/// Orchestrates approval for `call_sql`. A call from the provider's tool
/// loop registers a oneshot with a request id; the UI calls
/// `ai_approve_tool_call` which fulfils it. We time out after 5 minutes so
/// a never-answered approval can't hang the chat forever.
#[derive(Default)]
pub struct ApprovalRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    /// User denied the tool call; the tool returns an error string to the
    /// model so it can adjust or apologise.
    Deny,
}

/// Per-tool auto-approval flags. When a flag is `true`, the dispatcher
/// skips the UI prompt and executes as if the user approved. Toggled
/// from the permissions drawer in the chat panel. Stateless across
/// restarts — we keep this in-memory so a granted permission expires at
/// the end of the app session, matching the user's expectation that
/// "allow this chat" is a temporary trust rather than a persistent ACL.
#[derive(Default, Debug)]
pub struct AutoApprovals {
    inner: Mutex<AutoApprovalFlags>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AutoApprovalFlags {
    /// Allow the model to list schemas / databases / tables without
    /// prompting. Defaults to `true` because schema shapes are safe —
    /// no rows ever leave the adapter through these tools.
    #[serde(default = "default_true")]
    pub read_schema: bool,
    /// Allow the model to fetch column/index/FK definitions via
    /// `describe_table`. Also shape-only.
    #[serde(default = "default_true")]
    pub read_structure: bool,
    /// Legacy master switch for `call_query`. Kept for back-compat with
    /// settings persisted before the per-tier split. When `true` it grants
    /// every non-destructive tier (read/write/create/delete) so old configs
    /// keep working; destructive statements still always prompt.
    #[serde(default)]
    pub call_query: bool,
    /// Per-operation auto-approval for `call_query`. Each tier is gated
    /// independently so the user can, e.g., let reads run silently while
    /// still being prompted before writes or schema changes. Destructive
    /// statements (no-WHERE DELETE/UPDATE, DROP, TRUNCATE) are NEVER
    /// auto-approvable and have no flag.
    #[serde(default)]
    pub call_query_read: bool,
    #[serde(default)]
    pub call_query_write: bool,
    #[serde(default)]
    pub call_query_create: bool,
    #[serde(default)]
    pub call_query_delete: bool,
    /// Allow the model to read/query databases OTHER than the one the user
    /// is currently focused on. Defaults to `false` — the AI is locked to the
    /// active database so it can't enumerate or touch the other (often dozens
    /// of) databases on the same server. When `false`, `list_schemas` returns
    /// only the active schema and `list_tables`/`describe_table`/`call_query`
    /// reject references to any other database.
    #[serde(default)]
    pub cross_database: bool,
    /// Allow `write_query_tab` to open / replace editor tabs.
    #[serde(default)]
    pub write_query_tab: bool,
    /// Allow `publish_notify` to send NOTIFY / PUBLISH.
    #[serde(default)]
    pub publish_notify: bool,
    /// Allow `subscribe_channel` to start LISTEN / SUBSCRIBE.
    #[serde(default)]
    pub subscribe_channel: bool,
}

fn default_true() -> bool { true }

impl Default for AutoApprovalFlags {
    fn default() -> Self {
        Self {
            read_schema: true,
            read_structure: true,
            call_query: false,
            call_query_read: false,
            call_query_write: false,
            call_query_create: false,
            call_query_delete: false,
            cross_database: false,
            write_query_tab: false,
            publish_notify: false,
            subscribe_channel: false,
        }
    }
}

impl AutoApprovals {
    pub async fn get(&self) -> AutoApprovalFlags {
        *self.inner.lock().await
    }

    pub async fn set(&self, flags: AutoApprovalFlags) {
        *self.inner.lock().await = flags;
    }

    /// Whether the model may reach databases other than the active one.
    pub(super) async fn cross_database(&self) -> bool {
        self.inner.lock().await.cross_database
    }

    pub(super) async fn allows(&self, tool: &str) -> bool {
        let f = *self.inner.lock().await;
        match tool {
            "list_schemas" | "list_tables" => f.read_schema,
            "describe_table" => f.read_structure,
            // `call_query` is gated per-tier via `allows_tier`, not here.
            // `open_object_tab` is the same class of action as `write_query_tab`
            // (the AI opens an editor tab for the user to review/save), so it
            // shares the auto-approval toggle rather than adding a new one.
            "write_query_tab" | "open_object_tab" => f.write_query_tab,
            "publish_notify" => f.publish_notify,
            "subscribe_channel" => f.subscribe_channel,
            _ => false,
        }
    }

    /// Per-tier gate for `call_query`. Destructive statements never auto-
    /// approve. The legacy `call_query` master grants every non-destructive
    /// tier so pre-split configs keep working.
    pub(super) async fn allows_tier(&self, tier: QueryTier) -> bool {
        if tier == QueryTier::Destructive {
            return false;
        }
        let f = *self.inner.lock().await;
        if f.call_query {
            return true; // legacy master switch covers all non-destructive tiers
        }
        match tier {
            QueryTier::Read => f.call_query_read,
            QueryTier::Write => f.call_query_write,
            QueryTier::Create => f.call_query_create,
            QueryTier::Delete => f.call_query_delete,
            QueryTier::Destructive => false,
        }
    }
}

impl ApprovalRegistry {
    pub async fn wait(&self, id: &str) -> Result<ApprovalDecision, AiError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(id.to_string(), tx);
        }
        // 5-minute cap — the UI banner is persistent so the user can reply
        // whenever, but we don't want to lock the tool loop forever.
        let deadline = tokio::time::timeout(Duration::from_secs(300), rx).await;
        // Always clean up the entry.
        {
            let mut guard = self.pending.lock().await;
            guard.remove(id);
        }
        match deadline {
            Ok(Ok(decision)) => Ok(decision),
            Ok(Err(_)) => Err(AiError::Other("approval channel closed".into())),
            Err(_) => Err(AiError::Other("approval timed out after 5 minutes".into())),
        }
    }

    pub async fn resolve(&self, id: &str, decision: ApprovalDecision) -> bool {
        let mut guard = self.pending.lock().await;
        if let Some(tx) = guard.remove(id) {
            let _ = tx.send(decision);
            true
        } else {
            false
        }
    }
}
