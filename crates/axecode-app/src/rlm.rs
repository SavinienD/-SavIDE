//! Chantier E1 — persistent sub-agents (`rlm`) and nuclear-family messaging
//! (`messages`), served as kernel host calls on top of the daemon's
//! [`SessionHost`]. Each REPL worker owns one [`FamilyHost`] for its session.
//!
//! * `rlm.spawn` creates a full child session (own kernel + journal) and
//!   returns immediately; the child's final report reaches the parent as a
//!   peer message (see [`FamilyHost::on_turn_finished`]).
//! * `messages.send` only reaches the parent, children and siblings.
//! * Before fanning out more than [`FANOUT_GUARD`] children in one turn, the
//!   provider quota is checked; a warning is returned, never an error.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use axecode_core::{
    session::{CreateSessionRequest, PeerMessage, SessionHost, SessionMeta, SessionStatus},
    ModelRef,
};

/// Children spawned in one turn beyond which the quota guard runs.
pub const FANOUT_GUARD: usize = 2;
/// Utilisation (percent) from which the quota guard warns.
pub const QUOTA_WARN_PERCENT: f64 = 80.0;

/// A sub-agent profile usable through `rlm(profile=...)`: harness
/// `subagent_spec` entries.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentProfile {
    pub id: String,
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub model: Option<ModelRef>,
}

/// Optional provider quota source (`provider_quota`, chantier G).
#[async_trait]
pub trait QuotaSource: Send + Sync {
    async fn quota(&self, model: &ModelRef) -> Option<Value>;
}

/// Last result of a sub-agent task, persisted under `<data_dir>/rlm/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentResult {
    pub id: String,
    pub session_name: String,
    pub text: String,
    pub ts: i64,
    #[serde(default)]
    pub truncated: bool,
    /// The task ended on an error (provider refusal, quota...).
    #[serde(default)]
    pub error: bool,
}

pub struct FamilyHost {
    host: Arc<dyn SessionHost>,
    session_id: String,
    data_dir: PathBuf,
    profiles: Vec<SubagentProfile>,
    quota: Option<Arc<dyn QuotaSource>>,
    spawned_this_turn: Mutex<usize>,
    delivered: Mutex<Vec<PeerMessage>>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn s<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn session_json(meta: &SessionMeta) -> Value {
    json!({
        "id": meta.id,
        "session_name": meta.name,
        "status": meta.status,
        "model": format!("{}/{}", meta.model.provider, meta.model.name),
        "children": meta.children.len(),
        "updated": meta.updated_at_ms,
    })
}

/// axe:bg-d — how often a long turn gets a fresh status of its sub-agents.
pub const SUBAGENTS_STATUS_EVERY: Duration = Duration::from_secs(180);

/// axe:bg-d — automatic status of the sub-agents still at work under
/// `parent_id` (descendants, depth shown by indentation): name, id, model,
/// how long since they started and since their last activity. `None` when
/// none is running.
pub fn render_subagents_status(parent_id: &str, sessions: &[SessionMeta], now_ms: i64) -> Option<String> {
    fn ago(now: i64, then: i64) -> String {
        let s = ((now - then).max(0) / 1000) as u64;
        if s < 60 { format!("{s} s") } else if s < 3600 { format!("{} min", s / 60) } else { format!("{} h {:02} min", s / 3600, (s % 3600) / 60) }
    }
    let mut lines = Vec::new();
    let mut stack: Vec<(String, usize)> = sessions
        .iter()
        .filter(|m| m.parent_id.as_deref() == Some(parent_id))
        .map(|m| (m.id.clone(), 0))
        .collect();
    stack.reverse();
    let mut seen = std::collections::HashSet::new();
    while let Some((id, depth)) = stack.pop() {
        if !seen.insert(id.clone()) || depth > 8 {
            continue;
        }
        let Some(m) = sessions.iter().find(|m| m.id == id) else { continue };
        if m.status == SessionStatus::Running {
            lines.push(format!(
                "{}- `{}` ({}) en cours, {}/{}, lancé il y a {}, dernière activité il y a {}, {} entrées de journal",
                "  ".repeat(depth),
                m.name,
                m.id,
                m.model.provider,
                m.model.name,
                ago(now_ms, m.created_at_ms),
                ago(now_ms, m.updated_at_ms),
                m.entry_count
            ));
        }
        let mut kids: Vec<(String, usize)> = sessions
            .iter()
            .filter(|c| c.parent_id.as_deref() == Some(id.as_str()))
            .map(|c| (c.id.clone(), depth + 1))
            .collect();
        kids.reverse();
        stack.extend(kids);
    }
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "<subagents_status>\nÉtat automatique de vos sous-agents encore au travail ({} en cours ; rafraîchi toutes les quelques minutes, leurs résultats vous parviennent comme messages des pairs) :\n{}\n</subagents_status>",
        lines.len(),
        lines.join("\n")
    ))
}

/// `"provider/model"` → [`ModelRef`].
pub fn parse_model(value: &str) -> Option<ModelRef> {
    let (provider, name) = value.split_once('/')?;
    (!provider.is_empty() && !name.is_empty()).then(|| ModelRef::new(provider, name))
}

/// Render delivered peer messages for the per-turn system reminder.
pub fn render_peer_messages(messages: &[PeerMessage], sessions: &[SessionMeta]) -> Option<String> {
    if messages.is_empty() {
        return None;
    }
    let name_of = |id: &str| {
        sessions
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| id.to_string())
    };
    let mut out = String::from("<queued_peer_messages>\n");
    for message in messages {
        out.push_str(&format!(
            "<peer-message from=\"{}\" session_id=\"{}\" entry_id=\"{}\">\n{}\n</peer-message>\n",
            name_of(&message.from_session),
            message.from_session,
            message.entry_id,
            message.text.trim()
        ));
    }
    out.push_str("</queued_peer_messages>");
    Some(out)
}

impl FamilyHost {
    pub fn new(
        host: Arc<dyn SessionHost>,
        session_id: impl Into<String>,
        data_dir: impl Into<PathBuf>,
        profiles: Vec<SubagentProfile>,
        quota: Option<Arc<dyn QuotaSource>>,
    ) -> Self {
        Self {
            host,
            session_id: session_id.into(),
            data_dir: data_dir.into(),
            profiles,
            quota,
            spawned_this_turn: Mutex::new(0),
            delivered: Mutex::new(Vec::new()),
        }
    }

    /// Whether `method` is served by [`FamilyHost::dispatch`].
    pub fn handles(method: &str) -> bool {
        method.starts_with("rlm.") || method.starts_with("messages.")
    }

    /// Call at the start of every turn with the peer messages delivered to it.
    pub fn begin_turn(&self, delivered: &[PeerMessage]) {
        if let Ok(mut count) = self.spawned_this_turn.lock() {
            *count = 0;
        }
        if let Ok(mut slot) = self.delivered.lock() {
            *slot = delivered.to_vec();
        }
    }

    pub async fn dispatch(&self, method: &str, params: &Value) -> Result<Value> {
        match method {
            "rlm.spawn" => self.spawn(params).await,
            "rlm.follow_up" => self.follow_up(params).await,
            "rlm.list" => self.list_children().await,
            "rlm.result" => Ok(serde_json::to_value(self.read_result(req(params, "id")?)?)?),
            "rlm.wait" => self.wait(params).await,
            "rlm.quota" => Ok(self.current_quota().await.unwrap_or(Value::Null)),
            "messages.send" => self.send(params).await,
            "messages.inbox" => Ok(serde_json::to_value(
                self.delivered.lock().map(|d| d.clone()).unwrap_or_default(),
            )?),
            "messages.family" => self.family_json().await,
            other => bail!("unknown family host call `{other}`"),
        }
    }

    async fn me(&self) -> Result<SessionMeta> {
        self.host
            .get_session(&self.session_id)
            .await
            .map_err(|e| anyhow!("{e}"))
    }

    /// `(parent, children, siblings)` of this session.
    pub async fn family(&self) -> Result<(Option<SessionMeta>, Vec<SessionMeta>, Vec<SessionMeta>)> {
        let me = self.me().await?;
        let all = self.host.list_sessions().await;
        let parent = me
            .parent_id
            .as_ref()
            .and_then(|pid| all.iter().find(|m| &m.id == pid).cloned());
        let children = all
            .iter()
            .filter(|m| m.parent_id.as_deref() == Some(me.id.as_str()))
            .cloned()
            .collect();
        let siblings = match &me.parent_id {
            Some(pid) => all
                .iter()
                .filter(|m| m.parent_id.as_ref() == Some(pid) && m.id != me.id)
                .cloned()
                .collect(),
            None => Vec::new(),
        };
        Ok((parent, children, siblings))
    }
}

fn req<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    s(params, key).ok_or_else(|| anyhow!("missing `{key}`"))
}

const RESULT_MAX_CHARS: usize = 16_000;

impl FamilyHost {
    fn results_dir(&self) -> PathBuf {
        self.data_dir.join("rlm")
    }

    fn read_result(&self, id: &str) -> Result<Option<SubagentResult>> {
        let path = self.results_dir().join(format!("{id}.json"));
        match std::fs::read_to_string(&path) {
            Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn find_profile(&self, key: &str) -> Option<&SubagentProfile> {
        let k = key.to_ascii_lowercase();
        self.profiles
            .iter()
            .find(|p| p.id.to_ascii_lowercase() == k || p.name.to_ascii_lowercase() == k)
    }

    async fn spawn(&self, params: &Value) -> Result<Value> {
        let prompt = req(params, "prompt")?.to_string();
        let me = self.me().await?;
        let (_, children, _) = self.family().await?;
        let profile = match s(params, "profile") {
            Some(key) => Some(
                self.find_profile(key)
                    .cloned()
                    .ok_or_else(|| anyhow!("unknown sub-agent profile `{key}`"))?,
            ),
            None => None,
        };
        let model = match s(params, "model") {
            Some(raw) => parse_model(raw).ok_or_else(|| anyhow!("model must be `provider/model`"))?,
            None => profile
                .as_ref()
                .and_then(|p| p.model.clone())
                // axe:sub-m — default sub-agent model from the REPL settings.
                .or_else(|| {
                    crate::repl::ReplSettings::load(&self.data_dir)
                        .subagent_default_model
                        .as_deref()
                        .and_then(|m| parse_model(m.trim()))
                })
                .unwrap_or_else(|| me.model.clone()),
        };
        let base = s(params, "name")
            .map(str::to_string)
            .or_else(|| profile.as_ref().map(|p| p.name.clone()))
            .unwrap_or_else(|| "subagent".into());
        let mut name = base.clone();
        let mut n = 2;
        while children.iter().any(|c| c.name == name) {
            name = format!("{base}-{n}");
            n += 1;
        }

        // Quota guard before fanning out (never blocking).
        let spawned = {
            let mut count = self.spawned_this_turn.lock().map_err(|_| anyhow!("poisoned"))?;
            *count += 1;
            *count
        };
        let mut warning = None;
        if spawned > FANOUT_GUARD {
            if let Some(quota) = self.current_quota().await {
                if let Some(pct) = max_utilization(&quota) {
                    if pct >= QUOTA_WARN_PERCENT {
                        warning = Some(format!(
                            "subscription quota at {pct:.0}% — {spawned} sub-agents spawned this turn; consider sequencing the rest unless the user asked for parallelism"
                        ));
                    }
                }
            }
        }

        let mut extra = format!(
            "# Sub-agent\n\nYou are the sub-agent `{name}`, spawned by the session `{}`. Work autonomously on the task in the first user message. Your final answer is delivered to your parent automatically; use `messages.send(..., receiver_role=\"parent\")` only for intermediate questions or heads-ups. You stay alive after your task: your parent may send follow-ups.",
            me.name
        );
        if let Some(profile) = &profile {
            extra.push_str(&format!("\n\n# Profile: {}\n\n{}", profile.name, profile.prompt.trim()));
        }
        let child = self
            .host
            .create_session(CreateSessionRequest {
                name: name.clone(),
                workspace_id: me.workspace_id.clone(),
                model,
                parent_id: Some(me.id.clone()),
                system_prompt_extra: Some(extra),
                initial_message: Some(prompt),
            })
            .await
            .map_err(|e| anyhow!("{e}"))?;
        let mut out = json!({ "id": child.id, "session_name": child.name });
        if let Some(w) = warning {
            out["warning"] = json!(w);
        }
        Ok(out)
    }

    async fn resolve_child(&self, key: &str) -> Result<SessionMeta> {
        let (_, children, _) = self.family().await?;
        children
            .into_iter()
            .find(|c| c.id == key || c.name == key)
            .ok_or_else(|| anyhow!("`{key}` is not a sub-agent of this session"))
    }

    async fn follow_up(&self, params: &Value) -> Result<Value> {
        let child = self.resolve_child(req(params, "id")?).await?;
        let id = self
            .host
            .post_peer_message(&self.session_id, &child.id, req(params, "text")?.to_string())
            .await
            .map_err(|e| anyhow!("{e}"))?;
        Ok(json!({ "delivered_to": child.id, "message_id": id }))
    }

    async fn list_children(&self) -> Result<Value> {
        let (_, children, _) = self.family().await?;
        Ok(Value::Array(
            children
                .iter()
                .map(|c| {
                    let mut v = session_json(c);
                    if let Ok(Some(r)) = self.read_result(&c.id) {
                        v["last_result_ts"] = json!(r.ts);
                        if r.error && c.status != SessionStatus::Running {
                            v["status"] = json!("error");
                        }
                    }
                    v
                })
                .collect(),
        ))
    }

    async fn wait(&self, params: &Value) -> Result<Value> {
        let child = self.resolve_child(req(params, "id")?).await?;
        let timeout = params.get("timeout_ms").and_then(Value::as_u64).map(Duration::from_millis);
        let started = std::time::Instant::now();
        let start_ms = now_ms();
        let mut seen_running = false;
        loop {
            let meta = self.host.get_session(&child.id).await.map_err(|e| anyhow!("{e}"))?;
            if meta.status == SessionStatus::Running {
                seen_running = true;
            } else if let Some(result) = self.read_result(&child.id)? {
                let settled = seen_running || started.elapsed() > Duration::from_secs(3);
                if result.ts >= start_ms || settled {
                    return Ok(serde_json::to_value(result)?);
                }
            }
            if timeout.is_some_and(|t| started.elapsed() >= t) {
                return Ok(Value::Null);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn current_quota(&self) -> Option<Value> {
        let source = self.quota.as_ref()?;
        let me = self.me().await.ok()?;
        source.quota(&me.model).await
    }

    async fn send(&self, params: &Value) -> Result<Value> {
        let text = req(params, "text")?;
        let role = s(params, "receiver_role").unwrap_or("parent");
        let mode = s(params, "mode").unwrap_or("new");
        let (parent, children, siblings) = self.family().await?;
        let target = match role {
            "parent" => parent.ok_or_else(|| anyhow!("this session has no parent"))?,
            "child" | "sibling" => {
                let key = req(params, "receiver_name")?;
                let pool = if role == "child" { children } else { siblings };
                pool.into_iter()
                    .find(|m| m.id == key || m.name == key)
                    .ok_or_else(|| anyhow!("no {role} named `{key}` (nuclear family only)"))?
            }
            other => bail!("receiver_role must be parent, child or sibling (got `{other}`)"),
        };
        let body = if mode == "follow_up" { text.to_string() } else { format!("[new task] {text}") };
        let id = self
            .host
            .post_peer_message(&self.session_id, &target.id, body)
            .await
            .map_err(|e| anyhow!("{e}"))?;
        Ok(json!({ "delivered_to": target.id, "message_id": id }))
    }

    async fn family_json(&self) -> Result<Value> {
        let (parent, children, siblings) = self.family().await?;
        Ok(json!({
            "parent": parent.as_ref().map(session_json),
            "children": children.iter().map(session_json).collect::<Vec<_>>(),
            "siblings": siblings.iter().map(session_json).collect::<Vec<_>>(),
        }))
    }

    /// Call when a turn of this session ends: a sub-agent's final answer is
    /// stored and delivered to its parent as a peer message.
    pub async fn on_turn_finished(&self, final_text: &str) -> Result<()> {
        self.deliver(final_text, false).await
    }

    /// Call when a turn of this session stops on an error: a sub-agent tells
    /// its parent, which would otherwise wait for a result that never comes.
    pub async fn on_turn_failed(&self, error: &str) -> Result<()> {
        self.deliver(error, true).await
    }

    async fn deliver(&self, final_text: &str, error: bool) -> Result<()> {
        let me = self.me().await?;
        let Some(parent_id) = me.parent_id.clone() else {
            return Ok(());
        };
        let text = final_text.trim();
        if text.is_empty() {
            return Ok(());
        }
        let truncated = text.chars().count() > RESULT_MAX_CHARS;
        let text: String = text.chars().take(RESULT_MAX_CHARS).collect();
        let result = SubagentResult {
            id: me.id.clone(),
            session_name: me.name.clone(),
            text: text.clone(),
            ts: now_ms(),
            truncated,
            error,
        };
        std::fs::create_dir_all(self.results_dir())?;
        std::fs::write(
            self.results_dir().join(format!("{}.json", me.id)),
            serde_json::to_vec_pretty(&result)?,
        )?;
        let body = if error {
            format!(
                "[sub-agent error] `{}` stopped on an error:\n\n{text}",
                me.name
            )
        } else {
            format!(
                "[sub-agent result] `{}` finished its task{}:\n\n{text}",
                me.name,
                if truncated { " (truncated)" } else { "" }
            )
        };
        self.host
            .post_peer_message(&me.id, &parent_id, body)
            .await
            .map_err(|e| anyhow!("{e}"))?;
        Ok(())
    }
}

/// Highest utilisation percentage found in a quota payload (tolerant of
/// shapes: `utilization`, `percent`, `used_percent`, 0..1 or 0..100).
pub fn max_utilization(value: &Value) -> Option<f64> {
    fn walk(v: &Value, best: &mut Option<f64>) {
        match v {
            Value::Object(map) => {
                for (k, child) in map {
                    let key = k.to_ascii_lowercase();
                    if key.contains("utilization") || key.contains("percent") {
                        if let Some(n) = child.as_f64() {
                            let pct = if n <= 1.0 { n * 100.0 } else { n };
                            *best = Some(best.map_or(pct, |b: f64| b.max(pct)));
                        }
                    }
                    walk(child, best);
                }
            }
            Value::Array(items) => items.iter().for_each(|i| walk(i, best)),
            _ => {}
        }
    }
    let mut best = None;
    walk(value, &mut best);
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utilization_shapes() {
        assert_eq!(max_utilization(&json!({"five_hour": {"utilization": 42.0}, "seven_day": {"utilization": 0.9}})), Some(90.0));
        assert_eq!(max_utilization(&json!({"x": 1})), None);
    }

    #[test]
    fn subagents_status_lists_running_descendants_only() {
        let meta = |id: &str, parent: Option<&str>, status: SessionStatus| -> SessionMeta {
            let mut m: SessionMeta = serde_json::from_value(json!({
                "id": id, "name": format!("n-{id}"), "workspaceId": "ws",
                "model": {"provider": "anthropic", "name": "claude"}, "status": status,
                "createdAtMs": 0, "updatedAtMs": 120_000, "entryCount": 7
            }))
            .unwrap();
            m.parent_id = parent.map(Into::into);
            m
        };
        let all = vec![
            meta("me", None, SessionStatus::Running),
            meta("a", Some("me"), SessionStatus::Running),
            meta("b", Some("me"), SessionStatus::Idle),
            meta("c", Some("b"), SessionStatus::Running),
            meta("z", Some("other"), SessionStatus::Running),
        ];
        let out = render_subagents_status("me", &all, 3_725_000).unwrap();
        assert!(out.contains("2 en cours"), "{out}");
        assert!(out.contains("- `n-a` (a) en cours, anthropic/claude, lancé il y a 1 h 02 min, dernière activité il y a 1 h 00 min, 7 entrées de journal"), "{out}");
        assert!(out.contains("  - `n-c` (c)"), "grandchild indented: {out}");
        assert!(!out.contains("n-b") && !out.contains("n-z"), "{out}");
        assert!(render_subagents_status("a", &all, 0).is_none());
    }

    #[test]
    fn model_parsing() {
        assert_eq!(parse_model("anthropic/claude").unwrap().name, "claude");
        assert!(parse_model("nope").is_none());
    }
}

/// One-shot migration of the legacy Settings > Agents profiles into global
/// harness `subagent_spec` entries. The legacy store is cleared only once every
/// profile has been written, so a failure is retried at the next start.
/// Returns the number of migrated profiles.
pub fn migrate_settings_profiles(store: &crate::AppStore) -> anyhow::Result<usize> {
    let settings = store.load_sub_agent_settings()?;
    if settings.agents.is_empty() {
        return Ok(0);
    }
    let home = axecode_harness::store::default_home()
        .ok_or_else(|| anyhow!("home directory not found"))?;
    let harness = axecode_harness::HarnessStore::open(&home);
    let existing: Vec<String> = harness
        .list(Some(axecode_harness::EntryKind::SubagentSpec), Some(axecode_harness::Scope::Global))
        .unwrap_or_default()
        .into_iter()
        .map(|e| e.meta.title)
        .collect();
    for agent in &settings.agents {
        if existing.iter().any(|t| t == &agent.name) {
            continue;
        }
        let mut tags = vec![format!("model:{}/{}", agent.model.provider, agent.model.name)];
        if !agent.enabled {
            tags.push("disabled".into());
        }
        let body = if agent.description.trim().is_empty() {
            agent.prompt.clone()
        } else {
            format!("> {}\n\n{}", agent.description.trim(), agent.prompt)
        };
        harness.create(
            axecode_harness::Scope::Global,
            axecode_harness::EntryKind::SubagentSpec,
            axecode_harness::NewEntry {
                title: agent.name.clone(),
                body,
                source: Some("settings-agents".into()),
                tags,
                ..Default::default()
            },
        )?;
    }
    store.save_sub_agent_settings(&crate::subagent::SubAgentSettings::default())?;
    Ok(settings.agents.len())
}
/// Harness `subagent_spec` entries (both scopes) as `rlm(profile=...)` profiles.
/// The body is the prompt; an optional `model: provider/name` tag selects the model.
pub fn profiles_from_harness(workspace_root: &std::path::Path) -> Vec<SubagentProfile> {
    let store = axecode_harness::HarnessStore::open(workspace_root);
    store
        .list(Some(axecode_harness::EntryKind::SubagentSpec), None)
        .unwrap_or_default()
        .into_iter()
        .filter(|e| !e.meta.tags.iter().any(|t| t == "disabled"))
        .map(|e| SubagentProfile {
            model: e
                .meta
                .tags
                .iter()
                .find_map(|t| t.strip_prefix("model:").and_then(|m| parse_model(m.trim()))),
            id: e.meta.id,
            name: e.meta.title,
            prompt: e.body,
        })
        .collect()
}
