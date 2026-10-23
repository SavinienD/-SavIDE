//! One-time import of the legacy SQLite conversation store
//! (`desktop-state.sqlite3`) into JSONL journals.

use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};
use serde_json::json;
use axecode_core::{ChatMessage, JournalEntryKind, ModelRef};

use crate::journal::{self, Journal};

pub const LEGACY_DB: &str = "desktop-state.sqlite3";
const MARKER: &str = ".legacy-imported";

/// Imports legacy conversations once; a marker file prevents re-imports.
/// Errors are logged, never fatal.
pub fn import_legacy_once(data_dir: &Path) -> usize {
    let marker = journal::sessions_dir(data_dir).join(MARKER);
    if marker.exists() {
        return 0;
    }
    let db = data_dir.join(LEGACY_DB);
    let count = if db.exists() {
        match import_legacy(&db, data_dir) {
            Ok(count) => count,
            Err(err) => {
                tracing::warn!(error = %err, "legacy conversation import failed");
                return 0;
            }
        }
    } else {
        0
    };
    let _ = std::fs::create_dir_all(journal::sessions_dir(data_dir));
    let _ = std::fs::write(&marker, json!({"imported": count}).to_string());
    tracing::info!(count, "legacy conversations imported");
    count
}

struct LegacyConversation {
    id: String,
    workspace_id: String,
    title: String,
    model_json: String,
}

pub fn import_legacy(db: &Path, data_dir: &Path) -> anyhow::Result<usize> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let conversations: Vec<LegacyConversation> = {
        let mut statement = conn.prepare(
            "select id, workspace_id, title, model_json from conversations order by created_at_ms asc",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(LegacyConversation {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                title: row.get(2)?,
                model_json: row.get(3)?,
            })
        })?;
        rows.filter_map(Result::ok).collect()
    };
    let mut imported = 0;
    for conversation in conversations {
        let messages: Vec<ChatMessage> = {
            let mut statement = conn.prepare(
                "select message_json from messages where conversation_id = ?1 order by ordinal asc",
            )?;
            let rows = statement.query_map(params![conversation.id], |row| row.get::<_, String>(0))?;
            rows.filter_map(Result::ok)
                .filter_map(|raw| serde_json::from_str(&raw).ok())
                .collect()
        };
        if messages.is_empty() {
            continue;
        }
        // Reuse the legacy id so the import stays idempotent.
        if Journal::exists(data_dir, &conversation.id) {
            continue;
        }
        let model: ModelRef = match serde_json::from_str(&conversation.model_json) {
            Ok(model) => model,
            Err(_) => continue,
        };
        let mut journal = Journal::create(
            data_dir,
            &conversation.id,
            JournalEntryKind::SessionCreated {
                name: conversation.title,
                workspace_id: conversation.workspace_id,
                model,
                parent_id: None,
                system_prompt_extra: None,
            },
        )?;
        journal.append(JournalEntryKind::Extension {
            name: "imported_from".into(),
            payload: json!(conversation.id),
        })?;
        for message in messages {
            journal.append(JournalEntryKind::Message {
                message,
                usage: None,
                turn_id: None,
            })?;
        }
        imported += 1;
    }
    Ok(imported)
}
