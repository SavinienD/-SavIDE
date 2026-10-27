//! Session lifecycle: load/unload, turns, recoverable workers.
//!
//! A worker is a supervised tokio task per running session; the heavy and
//! crash-prone part (the Python kernel) is a child process owned by the
//! runtime. When a worker panics or the runtime reports a fatal error, the
//! runtime is rebuilt from the journal and the last kernel snapshot, and the
//! turn is resumed (`TurnInput::Resume`).

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};

use serde_json::{json, Value};
use axecode_core::{
    ChatMessage, CreateSessionRequest, EntryId, JournalEntryKind, ModelRef, SessionError,
    SessionMeta, SessionResult, SessionStatus, TurnInput,
};

use crate::{
    daemon::{lock, Daemon, Slot},
    journal::{self, Journal},
    util::new_id,
};

/// axe:e3 — un identifiant de session ne peut pas porter de syntaxe de chemin
/// (l'identifiant sert de nom de fichier, y compris dans le dossier d'archive).
pub(crate) fn valid_session_id(id: &str) -> SessionResult<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(SessionError::Protocol("invalid session id".into()));
    }
    Ok(())
}

/// axe:e3 — déplacement même-volume, avec repli copie+suppression hors volume.
fn move_file(src: &Path, dst: &Path) -> SessionResult<()> {
    match std::fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(18) => {
            std::fs::copy(src, dst)?;
            std::fs::remove_file(src)?;
            Ok(())
        }
        Err(e) => Err(SessionError::Io(e.to_string())),
    }
}

impl Daemon {
    pub fn list_metas(&self) -> Vec<SessionMeta> {
        let mut metas: Vec<SessionMeta> = lock(&self.sessions)
            .values()
            .map(|s| s.meta.clone())
            .collect();
        metas.sort_by_key(|m| std::cmp::Reverse(m.updated_at_ms));
        metas
    }

    /// axe:e3 — visibilité d'une métadonnée (racine de l'espace configurée).
    fn visible_meta(&self, meta: &SessionMeta, root: Option<&Path>) -> bool {
        let Some(root) = root else {
            return true;
        };
        let Ok(path) = PathBuf::from(&meta.workspace_id).canonicalize() else {
            return false;
        };
        path.is_dir() && path.starts_with(root)
    }

    /// axe:e3 — racine de l'espace de travail, canonisée (contrôle de visibilité).
    fn workspace_root_canon(&self) -> SessionResult<Option<PathBuf>> {
        self.config
            .workspace_root
            .as_ref()
            .map(|r| r.canonicalize())
            .transpose()
            .map_err(|e| SessionError::Io(e.to_string()))
    }

    /// axe:e3 — conversations archivées, avec leur état. Le chemin d'archive
    /// n'est jamais renvoyé : seuls l'identifiant, les métadonnées et l'état
    /// sortent du daemon.
    pub fn list_archived_entries(&self) -> SessionResult<Value> {
        let root = self.workspace_root_canon()?;
        let mut out: Vec<Value> = Vec::new();
        for id in journal::list_archived_ids(&self.config.data_dir) {
            // axe:menage — plain or compressed archive.
            let Ok(journal) = journal::open_archived(&self.config.data_dir, &id) else {
                continue;
            };
            let Some(mut meta) = journal.rebuild_meta() else {
                continue;
            };
            if !self.visible_meta(&meta, root.as_deref()) {
                continue;
            }
            meta.archived = true;
            meta.status = SessionStatus::Inactive;
            let mut value = serde_json::to_value(&meta)?;
            if let Some(object) = value.as_object_mut() {
                object.insert("state".into(), json!("archive"));
            }
            out.push(value);
        }
        out.sort_by_key(|value| {
            std::cmp::Reverse(
                value
                    .get("updatedAtMs")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
            )
        });
        Ok(Value::Array(out))
    }

    /// axe:journal-archive — journal d'une conversation archivée, en lecture seule,
    /// si elle existe et reste visible dans l'espace (sinon `None` / introuvable).
    pub(crate) fn archived_journal_readonly(&self, id: &str) -> SessionResult<Option<Journal>> {
        valid_session_id(id)?;
        if !journal::archive_exists(&self.config.data_dir, id) {
            return Ok(None);
        }
        let journal = journal::open_archived(&self.config.data_dir, id)?;
        let root = self.workspace_root_canon()?;
        if root.is_some() {
            let visible = journal
                .rebuild_meta()
                .is_some_and(|meta| self.visible_meta(&meta, root.as_deref()));
            if !visible {
                return Err(SessionError::NotFound(id.to_string()));
            }
        }
        Ok(Some(journal))
    }

    pub fn meta(&self, id: &str) -> SessionResult<SessionMeta> {
        lock(&self.sessions)
            .get(id)
            .map(|s| s.meta.clone())
            .ok_or_else(|| SessionError::NotFound(id.to_string()))
    }

    /// Returns the journal of a session, loading it from disk if needed.
    pub fn journal(&self, id: &str) -> SessionResult<Arc<Mutex<Journal>>> {
        let mut sessions = lock(&self.sessions);
        let slot = sessions
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if let Some(journal) = &slot.journal {
            return Ok(journal.clone());
        }
        let journal = Arc::new(Mutex::new(Journal::open(&self.config.data_dir, id)?));
        slot.journal = Some(journal.clone());
        if slot.meta.status == SessionStatus::Inactive {
            slot.meta.status = SessionStatus::Idle;
        }
        slot.last_active = Instant::now();
        Ok(journal)
    }

    fn refresh_meta(&self, id: &str) {
        let Ok(journal) = self.journal(id) else {
            return;
        };
        let rebuilt = lock(&journal).rebuild_meta();
        if let Some(rebuilt) = rebuilt {
            let mut sessions = lock(&self.sessions);
            if let Some(slot) = sessions.get_mut(id) {
                let status = slot.meta.status;
                let children = std::mem::take(&mut slot.meta.children);
                slot.meta = SessionMeta {
                    status,
                    children,
                    ..rebuilt
                };
                slot.last_active = Instant::now();
            }
        }
    }

    /// axe:eveil — Windows stays awake while at least one session runs.
    fn refresh_keep_awake(&self, sessions: &std::collections::HashMap<String, crate::daemon::Slot>) {
        let running = sessions
            .values()
            .filter(|s| s.meta.status == SessionStatus::Running)
            .count();
        self.keep_awake.update(running);
    }

    pub(crate) fn set_status(&self, id: &str, status: SessionStatus) {
        let meta = {
            let mut sessions = lock(&self.sessions);
            let Some(slot) = sessions.get_mut(id) else {
                return;
            };
            if slot.meta.status == status {
                return;
            }
            slot.meta.status = status;
            slot.last_active = Instant::now();
            let meta = slot.meta.clone();
            self.refresh_keep_awake(&sessions);
            meta
        };
        self.touch();
        self.broadcast(
            "status",
            Some(id),
            serde_json::to_value(&meta).unwrap_or(Value::Null),
        );
    }

    /// Appends an entry, refreshes metadata and notifies attached clients.
    pub fn append(&self, id: &str, kind: JournalEntryKind) -> SessionResult<EntryId> {
        let journal = self.journal(id)?;
        let (entry_id, entry) = {
            let mut journal = lock(&journal);
            let entry_id = journal.append(kind)?;
            let entry = journal.get(&entry_id).cloned();
            (entry_id, entry)
        };
        {
            let mut sessions = lock(&self.sessions);
            if let Some(slot) = sessions.get_mut(id) {
                slot.meta.leaf = Some(entry_id.clone());
                slot.meta.entry_count += 1;
                slot.meta.updated_at_ms = crate::util::now_ms();
                slot.last_active = Instant::now();
            }
        }
        if let Some(entry) = entry {
            self.broadcast(
                "entry",
                Some(id),
                serde_json::to_value(entry).unwrap_or_default(),
            );
        }
        Ok(entry_id)
    }

    pub fn create(&self, request: CreateSessionRequest) -> SessionResult<SessionMeta> {
        let request = self.confine_workspace(request)?;
        self.create_with_id(new_id(), request, Vec::new())
    }

    /// Returns the session `id`, creating it (seeded with `history`) when it
    /// does not exist yet. Used by the IDE to map conversations to sessions.
    pub fn ensure(
        &self,
        id: &str,
        request: CreateSessionRequest,
        history: Vec<ChatMessage>,
    ) -> SessionResult<SessionMeta> {
        // Session ids become journal filenames; never accept path syntax.
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(SessionError::Protocol("invalid session id".into()));
        }
        let request = self.confine_workspace(request)?;
        if let Ok(meta) = self.meta(id) {
            if meta.model != request.model {
                self.set_model(id, request.model)?;
            }
            return self.meta(id);
        }
        if Journal::exists(&self.config.data_dir, id) {
            return Err(SessionError::Journal(format!(
                "unreadable journal for {id}"
            )));
        }
        self.create_with_id(id.to_string(), request, history)
    }

    fn create_with_id(
        &self,
        id: String,
        mut request: CreateSessionRequest,
        history: Vec<ChatMessage>,
    ) -> SessionResult<SessionMeta> {
        self.prepare_workspace(&id, &mut request)?; // axe:freechat
        let mut journal = Journal::create(
            &self.config.data_dir,
            &id,
            JournalEntryKind::SessionCreated {
                name: request.name.clone(),
                workspace_id: request.workspace_id.clone(),
                model: request.model.clone(),
                parent_id: request.parent_id.clone(),
                system_prompt_extra: request.system_prompt_extra.clone(),
            },
        )?;
        for message in history {
            journal.append(JournalEntryKind::Message {
                message,
                usage: None,
                turn_id: None,
            })?;
        }
        self.insert_loaded(journal, request.parent_id.as_deref())?;
        if let Some(text) = request.initial_message {
            self.send_user(&id, ChatMessage::user_text(text))?;
        }
        self.meta(&id)
    }

    // axe:v2-l7 — l'IDE manipule un identifiant virtuel `axe-cloud://<connexion>/<racine>`
    // (ex. `axe-cloud://axe-cloud/work`) qui n'existe pas sur le service. On ignore la
    // connexion (le service a une racine fixe) et on exige que le reste commence par le
    // nom de base de la racine de travail configurée. `None` = chemin local, inchangé.
    fn cloud_workspace(&self, raw: &str) -> SessionResult<Option<PathBuf>> {
        let Some(rest) = raw.strip_prefix("axe-cloud://") else {
            return Ok(None);
        };
        let Some(configured) = self.config.workspace_root.as_ref() else {
            return Err(SessionError::Protocol(
                "cloud workspace requires a configured workspace root".into(),
            ));
        };
        let root = configured
            .canonicalize()
            .map_err(|e| SessionError::Io(e.to_string()))?;
        let root_name = root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let (_connection, path) = rest.split_once('/').unwrap_or((rest, ""));
        let mut parts = path.split('/').filter(|part| !part.is_empty());
        let Some(first) = parts.next() else {
            return Err(SessionError::Protocol(
                "cloud workspace is missing its root".into(),
            ));
        };
        if first != root_name {
            return Err(SessionError::Protocol(format!(
                "cloud workspace must be under /{root_name}"
            )));
        }
        let mut out = root.clone();
        for part in parts {
            if part == "." || part == ".." || part.contains('\\') || part.contains(':') {
                return Err(SessionError::Protocol(
                    "invalid cloud workspace path".into(),
                ));
            }
            out.push(part);
        }
        Ok(Some(out))
    }

    /// Cloud sessions must stay inside the root configured by the service unit.
    fn confine_workspace(
        &self,
        mut request: CreateSessionRequest,
    ) -> SessionResult<CreateSessionRequest> {
        let raw = request.workspace_id.trim().to_string();
        // axe:v2-l7 — traduire d'abord les identifiants cloud, y compris pour
        // refuser explicitement quand aucune racine n'est configurée.
        let cloud = self.cloud_workspace(&raw)?;
        let Some(configured) = self.config.workspace_root.as_ref() else {
            return Ok(request);
        };
        let root = configured
            .canonicalize()
            .map_err(|e| SessionError::Io(e.to_string()))?;
        if !root.is_dir() {
            return Err(SessionError::Protocol(
                "workspace root is not a directory".into(),
            ));
        }
        if raw.is_empty() {
            // axe:v2-e10 — le dossier n'est JAMAIS demandé à l'utilisateur : il ne
            // connaît pas la machine distante. Sans dossier, la session prend la
            // racine de travail du compte, que seul le service connaît (une seule
            // racine par compte, imposée par l'unité systemd).
            request.workspace_id = root.display().to_string();
            return Ok(request);
        }
        let supplied = cloud.unwrap_or_else(|| PathBuf::from(&raw));
        let candidate = if supplied.is_absolute() {
            supplied
        } else {
            root.join(supplied)
        };
        let canonical = candidate
            .canonicalize()
            .map_err(|e| SessionError::Io(e.to_string()))?;
        if !canonical.starts_with(&root) || !canonical.is_dir() {
            return Err(SessionError::Protocol(
                "session workspace is outside the configured root".into(),
            ));
        }
        request.workspace_id = canonical.display().to_string();
        Ok(request)
    }

    // axe:freechat
    /// A request without folder is a free conversation: its workspace is a
    /// private, persistent scratch folder named after the session.
    fn prepare_workspace(&self, id: &str, request: &mut CreateSessionRequest) -> SessionResult<()> {
        let data_dir = &self.config.data_dir;
        if request.workspace_id.trim().is_empty() {
            let dir = crate::scratch::scratch_dir(data_dir, id);
            std::fs::create_dir_all(&dir)?;
            // Same form as the IDE (canonical path) so both sides agree.
            let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
            request.workspace_id = dir.display().to_string();
        } else if crate::scratch::is_scratch(data_dir, &request.workspace_id) {
            std::fs::create_dir_all(&request.workspace_id)?;
        }
        Ok(())
    }

    /// Moves a session to another folder (a free conversation opened in a
    /// project). The runtime is unloaded so that the next turn restarts the
    /// kernel there; its variables come back from the snapshot.
    pub async fn relocate(
        &self,
        id: &str,
        workspace_id: String,
        system_prompt_extra: Option<String>,
    ) -> SessionResult<SessionMeta> {
        if workspace_id.trim().is_empty() {
            return Err(SessionError::Protocol("missing workspaceId".into()));
        }
        // axe:v2-l7 — même traduction que `sessions.create` : un identifiant
        // `axe-cloud://...` reçu du front devient le chemin réel sous la racine.
        let cloud = self.cloud_workspace(workspace_id.trim())?;
        let workspace_id = if let Some(configured) = self.config.workspace_root.as_ref() {
            let root = configured
                .canonicalize()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            let supplied = cloud.unwrap_or_else(|| PathBuf::from(&workspace_id));
            let candidate = if supplied.is_absolute() {
                supplied
            } else {
                root.join(supplied)
            };
            let canonical = candidate
                .canonicalize()
                .map_err(|e| SessionError::Io(e.to_string()))?;
            if !canonical.starts_with(&root) || !canonical.is_dir() {
                return Err(SessionError::Protocol(
                    "session workspace is outside the configured root".into(),
                ));
            }
            canonical.display().to_string()
        } else {
            workspace_id
        };
        let running = lock(&self.sessions)
            .get(id)
            .map(|slot| slot.cancel.is_some())
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if running {
            return Err(SessionError::Busy(id.to_string()));
        }
        self.append(
            id,
            JournalEntryKind::Meta {
                name: None,
                archived: None,
                workspace_id: Some(workspace_id),
                system_prompt_extra,
            },
        )?;
        self.refresh_meta(id);
        self.unload(id).await;
        self.meta(id)
    }
    // axe:freechat end

    fn insert_loaded(&self, journal: Journal, parent: Option<&str>) -> SessionResult<()> {
        let mut meta = journal
            .rebuild_meta()
            .ok_or_else(|| SessionError::Journal("invalid journal root".into()))?;
        meta.status = SessionStatus::Idle;
        let id = meta.id.clone();
        {
            let mut sessions = lock(&self.sessions);
            if let Some(parent) = parent.and_then(|p| sessions.get_mut(p)) {
                parent.meta.children.push(id.clone());
            }
            sessions.insert(
                id.clone(),
                Slot {
                    meta: meta.clone(),
                    journal: Some(Arc::new(Mutex::new(journal))),
                    runtime: None,
                    cancel: None,
                    queue: VecDeque::new(),
                    held: Vec::new(),
                    last_active: Instant::now(),
                },
            );
        }
        self.touch();
        self.broadcast(
            "status",
            Some(&id),
            serde_json::to_value(&meta).unwrap_or_default(),
        );
        Ok(())
    }

    /// Clones the session at `entry` (default: current leaf) into a new one.
    /// axe:arriere-plan — `parent` : session parente du clone (défaut : le
    /// parent de la source) ; l'instantané du noyau de la source est copié,
    /// le clone garde donc ses variables.
    pub fn fork(
        &self,
        id: &str,
        entry: Option<String>,
        name: Option<String>,
        parent: Option<String>,
    ) -> SessionResult<SessionMeta> {
        let source = self.meta(id)?;
        let parent_id = match parent {
            Some(parent) => Some(self.meta(&parent)?.id),
            None => source.parent_id.clone(),
        };
        let journal = self.journal(id)?;
        let new_id = new_id();
        let child = {
            let journal = lock(&journal);
            let entry = entry
                .or_else(|| journal.leaf().cloned())
                .ok_or_else(|| SessionError::Journal("empty journal".into()))?;
            journal.fork(
                &self.config.data_dir,
                &new_id,
                &entry,
                JournalEntryKind::SessionCreated {
                    name: name.unwrap_or_else(|| format!("{} (fork)", source.name)),
                    workspace_id: source.workspace_id.clone(),
                    model: journal.current_model().unwrap_or(source.model.clone()),
                    parent_id: parent_id.clone(),
                    system_prompt_extra: source.system_prompt_extra.clone(),
                },
            )?
        };
        // Avant l'insertion : le premier tour du clone trouve déjà l'instantané.
        let instantane = journal::snapshot_path(&self.config.data_dir, id);
        if instantane.exists() {
            if let Err(err) =
                std::fs::copy(&instantane, journal::snapshot_path(&self.config.data_dir, &new_id))
            {
                tracing::warn!(session = %id, error = %err, "fork: kernel snapshot not copied");
            }
        }
        self.insert_loaded(child, parent_id.as_deref())?;
        self.meta(&new_id)
    }

    pub fn move_leaf(
        &self,
        id: &str,
        entry: &str,
        label: Option<String>,
    ) -> SessionResult<EntryId> {
        self.append(
            id,
            JournalEntryKind::Pointer {
                leaf: entry.to_string(),
                label,
            },
        )
    }

    pub fn set_model(&self, id: &str, model: ModelRef) -> SessionResult<()> {
        let journal = self.journal(id)?;
        let from = lock(&journal).current_model();
        let from = from.unwrap_or(self.meta(id)?.model);
        if from == model {
            return Ok(());
        }
        self.append(
            id,
            JournalEntryKind::ModelSwitch {
                from,
                to: model.clone(),
            },
        )?;
        self.refresh_meta(id);
        let runtime = lock(&self.sessions).get(id).and_then(|s| s.runtime.clone());
        if let Some(runtime) = runtime {
            let model = model.clone();
            tokio::spawn(async move {
                let _ = runtime.set_model(model).await;
            });
        }
        Ok(())
    }

    /// axe:e3 — archiver une conversation **et celles qui en découlent** : un
    /// fil archivé ne doit pas laisser d'enfants orphelins dans les
    /// conversations actives. Les enfants partent d'abord, le parent ensuite.
    pub fn archive(&self, id: &str) -> SessionResult<Value> {
        let ids = self.subtree_ids(id)?;
        let mut value = Value::Null;
        for one in ids {
            value = self.archive_one(&one)?;
        }
        Ok(value)
    }

    /// axe:e3 — identifiants d'une conversation active et de ses descendantes,
    /// les enfants d'abord. Refuse une conversation qui n'est pas active.
    fn subtree_ids(&self, id: &str) -> SessionResult<Vec<String>> {
        valid_session_id(id)?;
        self.meta(id)
            .map_err(|_| SessionError::NotFound(id.to_string()))?;
        let mut out: Vec<String> = Vec::new();
        let mut pile: Vec<String> = vec![id.to_string()];
        while let Some(current) = pile.pop() {
            if out.iter().any(|seen| seen == &current) {
                continue; // une boucle est impossible, on ne s'y fie pas pour autant
            }
            if let Ok(meta) = self.meta(&current) {
                pile.extend(meta.children.iter().cloned());
            }
            out.push(current);
        }
        out.reverse();
        Ok(out)
    }

    /// axe:e3 — archiver une seule conversation : elle quitte les conversations
    /// actives et son journal part dans le dossier d'archive, dont le chemin
    /// n'est jamais communiqué. Le déplacement est un `rename` : l'inode ne
    /// change pas, donc une écriture résiduelle du tour en cours atterrit dans
    /// le fichier archivé au lieu d'être perdue.
    pub(crate) fn archive_one(&self, id: &str) -> SessionResult<Value> {
        valid_session_id(id)?;
        let _archive = lock(&self.archive_lock); // axe:menage
        let root = self.workspace_root_canon()?;
        let journal_path = journal::journal_path(&self.config.data_dir, id);
        let journal = Journal::open_path(&journal_path)
            .map_err(|_| SessionError::NotFound(id.to_string()))?;
        let mut meta = journal
            .rebuild_meta()
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if !self.visible_meta(&meta, root.as_deref()) {
            return Err(SessionError::NotFound(id.to_string()));
        }

        // 1. La conversation ne doit plus travailler.
        self.stop(id).ok();

        // 2. L'état d'archive est écrit **avant** le déplacement : une coupure
        //    ne peut pas laisser un fichier archivé présenté comme actif.
        let marque = JournalEntryKind::Meta {
            name: None,
            archived: Some(true),
            workspace_id: None,
            system_prompt_extra: None,
        };
        match self.append(id, marque.clone()) {
            Ok(_) => {}
            Err(_) => {
                let mut journal = Journal::open_path(&journal_path)?;
                journal.append(marque)?;
            }
        }

        // 3. Journal et instantané de noyau partent dans l'archive.
        std::fs::create_dir_all(journal::archive_dir(&self.config.data_dir))?;
        move_file(
            &journal_path,
            &journal::archive_path(&self.config.data_dir, id),
        )?;
        let snapshot = journal::snapshot_path(&self.config.data_dir, id);
        if snapshot.exists() {
            move_file(
                &snapshot,
                &journal::archive_snapshot_path(&self.config.data_dir, id),
            )?;
        }

        // 4. Plus rien en mémoire : la conversation n'est plus active, et son
        //    parent ne la liste plus.
        {
            let mut sessions = lock(&self.sessions);
            if let Some(parent) = meta.parent_id.clone() {
                if let Some(slot) = sessions.get_mut(&parent) {
                    slot.meta.children.retain(|child| child != id);
                }
            }
            sessions.remove(id);
            // axe:eveil — a session archived while running no longer counts.
            self.refresh_keep_awake(&sessions);
        }
        meta.archived = true;
        meta.status = SessionStatus::Inactive;
        // axe:menage — an archived sub-agent stays visible to the runtimes.
        if meta.parent_id.is_some() {
            lock(&self.archived_subagents)
                .insert(id.to_string(), crate::menage::index_entry(meta.clone()));
        }
        let mut value = serde_json::to_value(&meta)?;
        if let Some(object) = value.as_object_mut() {
            object.insert("state".into(), json!("archive"));
        }
        self.broadcast("status", Some(id), value.clone());
        Ok(value)
    }

    /// axe:e3 — rétablir une conversation archivée : elle revient dans les
    /// conversations actives, journal à l'appui. Rien ne peut être rétabli qui
    /// n'ait été archivé.
    pub fn restore_archived(&self, id: &str) -> SessionResult<Value> {
        valid_session_id(id)?;
        let _archive = lock(&self.archive_lock); // axe:menage
        self.restore_archived_locked(id)
    }

    /// axe:menage — [`Self::restore_archived`] with `archive_lock` held.
    pub(crate) fn restore_archived_locked(&self, id: &str) -> SessionResult<Value> {
        valid_session_id(id)?;
        let archived = journal::archive_path(&self.config.data_dir, id);
        if !journal::archive_exists(&self.config.data_dir, id) {
            return Err(SessionError::Protocol(
                "rétablissement refusé : cette conversation n'est pas archivée".into(),
            ));
        }
        let root = self.workspace_root_canon()?;
        let journal = journal::open_archived(&self.config.data_dir, id)?;
        let mut meta = journal
            .rebuild_meta()
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if !self.visible_meta(&meta, root.as_deref()) {
            return Err(SessionError::NotFound(id.to_string()));
        }
        // axe:menage — a compressed archive comes back to its plain form
        // first (the `.gz` stays untouched if it cannot be read).
        journal::inflate_archive(&self.config.data_dir, id)?;

        // 1. L'état est remis à « active » dans le journal, avant le retour.
        {
            let mut journal = Journal::open_path(&archived)?;
            journal.append(JournalEntryKind::Meta {
                name: None,
                archived: Some(false),
                workspace_id: None,
                system_prompt_extra: None,
            })?;
        }

        // 2. Retour du journal et de l'instantané dans les conversations actives.
        move_file(&archived, &journal::journal_path(&self.config.data_dir, id))?;
        let snapshot = journal::archive_snapshot_path(&self.config.data_dir, id);
        let mut duplicates = vec![journal::gz_path(&archived)];
        if snapshot.exists() {
            move_file(&snapshot, &journal::snapshot_path(&self.config.data_dir, id))?;
            duplicates.push(journal::gz_path(&snapshot));
        }
        // axe:menage — a `.gz` left next to its plain file (compression cut
        // before removing the original) is a checked copy: it goes. A `.gz`
        // without plain file (unreadable snapshot) stays where it is.
        for gz in duplicates.iter().filter(|gz| gz.exists()) {
            if let Err(err) = std::fs::remove_file(gz) {
                tracing::warn!(file = %gz.display(), error = %err, "compressed copy not removed");
            }
        }

        // 3. La conversation redevient active : on la remet en mémoire
        //    exactement comme le fait le démarrage du daemon (aucun runtime
        //    n'est ouvert avant la première requête). `ensure` ne conviendrait
        //    pas : il refuse, par sécurité, un journal présent mais non chargé.
        {
            let mut sessions = lock(&self.sessions);
            meta.children.clear();
            // axe:menage — the meta was read before the « active » mark: it
            // must not stay flagged archived in memory (lists would hide it).
            meta.archived = false;
            if let Some(parent) = meta.parent_id.clone() {
                match sessions.get_mut(&parent) {
                    Some(slot) => slot.meta.children.push(meta.id.clone()),
                    None => meta.parent_id = None,
                }
            }
            sessions.insert(
                id.to_string(),
                Slot {
                    meta: meta.clone(),
                    journal: None,
                    runtime: None,
                    cancel: None,
                    queue: VecDeque::new(),
                    held: Vec::new(),
                    last_active: Instant::now(),
                },
            );
        }

        lock(&self.archived_subagents).remove(id); // axe:menage
        meta.archived = false;
        meta.status = SessionStatus::Inactive;
        let mut value = serde_json::to_value(&meta)?;
        if let Some(object) = value.as_object_mut() {
            object.insert("state".into(), json!("actif"));
        }
        Ok(value)
    }

    /// axe:e3 — supprimer une conversation **archivée**. Toute autre demande
    /// est refusée : la suppression n'est possible que depuis l'archive, pour
    /// qu'un geste ne détruise jamais une conversation en cours de travail.
    pub fn delete_archived(&self, id: &str) -> SessionResult<Value> {
        valid_session_id(id)?;
        let _archive = lock(&self.archive_lock); // axe:menage
        if !journal::archive_exists(&self.config.data_dir, id) {
            return Err(SessionError::Protocol(
                "suppression refusée : archivez d'abord la conversation".into(),
            ));
        }
        let root = self.workspace_root_canon()?;
        let journal = journal::open_archived(&self.config.data_dir, id)?;
        let meta = journal
            .rebuild_meta()
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        if !self.visible_meta(&meta, root.as_deref()) {
            return Err(SessionError::NotFound(id.to_string()));
        }
        // axe:menage — plain and compressed files alike.
        for file in journal::archive_files(&self.config.data_dir, id) {
            if file.exists() {
                std::fs::remove_file(&file)?;
            }
        }
        lock(&self.archived_subagents).remove(id); // axe:menage
        Ok(json!({"ok": true, "id": id, "state": "supprime"}))
    }

    pub fn update(
        &self,
        id: &str,
        name: Option<String>,
        archived: Option<bool>,
    ) -> SessionResult<()> {
        self.append(
            id,
            JournalEntryKind::Meta {
                name,
                archived,
                workspace_id: None,
                system_prompt_extra: None,
            },
        )?;
        self.refresh_meta(id);
        let meta = self.meta(id)?;
        self.broadcast(
            "status",
            Some(id),
            serde_json::to_value(meta).unwrap_or_default(),
        );
        Ok(())
    }

    /// Journals a user message and schedules a turn. During a turn the
    /// message is held and journaled when the turn ends, so that it never
    /// lands between a tool call and its result; the entry id is then empty.
    pub fn send_user(&self, id: &str, message: ChatMessage) -> SessionResult<EntryId> {
        if let Some(slot) = lock(&self.sessions)
            .get_mut(id)
            .filter(|s| s.cancel.is_some())
        {
            slot.held.push(message);
            return Ok(EntryId::new());
        }
        self.journal_user(id, message)
    }

    pub(crate) fn journal_user(&self, id: &str, message: ChatMessage) -> SessionResult<EntryId> {
        let entry = self.append(
            id,
            JournalEntryKind::Message {
                message: message.clone(),
                usage: None,
                turn_id: None,
            },
        )?;
        self.enqueue(id, TurnInput::User { message });
        Ok(entry)
    }

    /// Journals a peer message; wakes the target if it is not running.
    pub fn post_peer(&self, from: &str, to: &str, text: String) -> SessionResult<EntryId> {
        let entry = self.append(
            to,
            JournalEntryKind::PeerMessage {
                from_session: from.to_string(),
                text,
            },
        )?;
        let running = lock(&self.sessions)
            .get(to)
            .is_some_and(|s| s.cancel.is_some());
        if !running {
            self.enqueue(to, TurnInput::Continue);
        }
        Ok(entry)
    }

    /// axe:bg-a — like [`Self::post_peer`] but never starts a turn: the
    /// message is delivered with the next one (system note to a conversation).
    pub fn post_peer_quiet(&self, from: &str, to: &str, text: String) -> SessionResult<EntryId> {
        self.append(
            to,
            JournalEntryKind::PeerMessage {
                from_session: from.to_string(),
                text,
            },
        )
    }

    /// axe:bg-a — a sub-agent (or background session) whose turn ended on a
    /// service-side failure still reports to its parent, which would
    /// otherwise wait for a result that never comes.
    pub(crate) fn report_failure_to_parent(&self, id: &str, error: &str) {
        let Ok(meta) = self.meta(id) else { return };
        let Some(parent) = meta.parent_id.clone() else { return };
        let text = format!("[sub-agent error] `{}` stopped on an error:\n\n{error}", meta.name);
        if let Err(err) = self.post_peer(id, &parent, text) {
            tracing::warn!(session = %id, error = %err, "failure report to parent lost");
        }
    }

    pub fn stop(&self, id: &str) -> SessionResult<()> {
        let mut sessions = lock(&self.sessions);
        let slot = sessions
            .get_mut(id)
            .ok_or_else(|| SessionError::NotFound(id.to_string()))?;
        slot.queue.clear();
        if let Some(cancel) = &slot.cancel {
            cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stub::EchoFactory;
    use axecode_core::ModelRef;
    use std::sync::Arc;

    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        daemon: Option<Arc<Daemon>>,
    }

    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("l7-sessions-{}", uuid::Uuid::new_v4()));
            let root = base.join("work");
            std::fs::create_dir_all(&root).unwrap();
            let mut config = crate::DaemonConfig::new(base.join("data"));
            config.workspace_root = Some(root.clone());
            let daemon = Daemon::new(config, Arc::new(EchoFactory));
            Self {
                base,
                root,
                daemon: Some(daemon),
            }
        }

        fn request(&self, workspace_id: &str) -> CreateSessionRequest {
            CreateSessionRequest {
                name: "l7".into(),
                workspace_id: workspace_id.into(),
                model: ModelRef::new("test", "echo"),
                parent_id: None,
                system_prompt_extra: None,
                initial_message: None,
            }
        }

        fn create(&self, workspace_id: &str) -> SessionResult<SessionMeta> {
            self.daemon
                .as_ref()
                .unwrap()
                .create(self.request(workspace_id))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.daemon = None;
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    /// axe:v2-e12f — une seule notion d'archive : demander `archived: true`
    /// par `sessions.update` range **vraiment** la conversation (le journal
    /// quitte les conversations actives) au lieu de poser un drapeau qui la
    /// laissait lisible. `archived: false` la retablit par la meme porte.
    #[tokio::test(flavor = "multi_thread")]
    async fn update_archived_uses_the_single_drawer() {
        use crate::protocol::methods;

        let f = Fixture::new();
        let meta = f.create("axe-cloud://axe-cloud/work").unwrap();
        let daemon = f.daemon.clone().unwrap();
        let data = daemon.config.data_dir.clone();
        let actif = journal::journal_path(&data, &meta.id);
        let archive = journal::archive_path(&data, &meta.id);
        assert!(actif.exists(), "la conversation neuve est active");
        assert!(!archive.exists(), "rien dans l'archive au depart");

        daemon
            .dispatch(
                0,
                methods::SESSIONS_UPDATE,
                json!({"sessionId": meta.id, "archived": true}),
            )
            .await
            .unwrap();
        assert!(!actif.exists(), "le journal ne doit plus etre actif");
        assert!(archive.exists(), "le journal doit etre dans l'archive");

        // Une conversation archivee n'est plus lisible par les chemins actifs.
        assert!(daemon
            .dispatch(0, methods::SESSIONS_GET, json!({"sessionId": meta.id}))
            .await
            .is_err());

        daemon
            .dispatch(
                0,
                methods::SESSIONS_UPDATE,
                json!({"sessionId": meta.id, "archived": false}),
            )
            .await
            .unwrap();
        assert!(actif.exists(), "le journal revient dans les actives");
        assert!(!archive.exists(), "l'archive est videe");
    }

    /// axe:arriere-plan — « Arrière-plan » : le clone est l'enfant de la
    /// conversation (vue Agents), garde les variables du noyau (instantané
    /// copié) et l'historique compacté de la conversation.
    #[tokio::test(flavor = "multi_thread")]
    async fn fork_en_arriere_plan() {
        use crate::protocol::methods;

        let f = Fixture::new();
        let daemon = f.daemon.clone().unwrap();
        let conv = f.create("axe-cloud://axe-cloud/work").unwrap();
        let msg = |t: &str| JournalEntryKind::Message {
            message: ChatMessage::user_text(t),
            usage: None,
            turn_id: None,
        };
        let a = daemon.append(&conv.id, msg("ancien 1")).unwrap();
        let b = daemon.append(&conv.id, msg("ancien 2")).unwrap();
        daemon
            .append(
                &conv.id,
                JournalEntryKind::Compaction {
                    summary: "RESUME".into(),
                    from_entry: a,
                    to_entry: b,
                    directive: None,
                },
            )
            .unwrap();
        daemon.append(&conv.id, msg("recent")).unwrap();
        let data = daemon.config.data_dir.clone();
        std::fs::write(journal::snapshot_path(&data, &conv.id), b"variables").unwrap();

        let enfant: SessionMeta = serde_json::from_value(
            daemon
                .dispatch(
                    0,
                    methods::SESSIONS_FORK,
                    json!({"sessionId": conv.id, "name": "Tâche — arrière-plan", "parentId": conv.id}),
                )
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(enfant.parent_id.as_deref(), Some(conv.id.as_str()));
        assert_eq!(enfant.name, "Tâche — arrière-plan");
        assert!(daemon.meta(&conv.id).unwrap().children.contains(&enfant.id));
        assert_eq!(
            std::fs::read(journal::snapshot_path(&data, &enfant.id)).unwrap(),
            b"variables".to_vec()
        );
        let source = lock(&daemon.journal(&conv.id).unwrap()).history();
        let clone = lock(&daemon.journal(&enfant.id).unwrap()).history();
        assert_eq!(
            serde_json::to_value(&clone).unwrap(),
            serde_json::to_value(&source).unwrap()
        );
        assert!(serde_json::to_string(&clone).unwrap().contains("RESUME"));

        // Sans parentId : comme avant, le parent de la source.
        let frere: SessionMeta = serde_json::from_value(
            daemon
                .dispatch(0, methods::SESSIONS_FORK, json!({"sessionId": conv.id}))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(frere.parent_id, None);
        // Parent inconnu : refusé.
        assert!(daemon
            .dispatch(
                0,
                methods::SESSIONS_FORK,
                json!({"sessionId": conv.id, "parentId": "inconnu"}),
            )
            .await
            .is_err());
    }

    #[test]
    fn cloud_identifier_maps_to_the_configured_root() {
        let f = Fixture::new();
        let canonical = std::fs::canonicalize(&f.root).unwrap();
        let meta = f.create("axe-cloud://axe-cloud/work").unwrap();
        assert_eq!(meta.workspace_id, canonical.display().to_string());

        // Le nom de la connexion est ignoré : seule la racine compte.
        let meta = f.create("axe-cloud://autre-connexion/work").unwrap();
        assert_eq!(meta.workspace_id, canonical.display().to_string());
    }

    /// axe:v2-e10 — aucun dossier n'est demandé à l'utilisateur : une session
    /// créée sans dossier atterrit dans la racine de travail du compte, que seul
    /// le service connaît. Avant, le service refusait (« require a workspace »)
    /// et l'utilisateur devait taper un chemin sur une machine qu'il ne voit pas.
    #[test]
    fn empty_workspace_falls_back_to_the_account_root() {
        let f = Fixture::new();
        let canonical = std::fs::canonicalize(&f.root).unwrap();
        let meta = f.create("").unwrap();
        assert_eq!(meta.workspace_id, canonical.display().to_string());
        let meta = f.create("   ").unwrap();
        assert_eq!(meta.workspace_id, canonical.display().to_string());
    }

    #[test]
    fn cloud_identifier_accepts_a_subfolder() {
        let f = Fixture::new();
        let sub = f.root.join("portail-prime");
        std::fs::create_dir_all(&sub).unwrap();
        let canonical = std::fs::canonicalize(&sub).unwrap();
        let meta = f
            .create("axe-cloud://axe-cloud/work/portail-prime")
            .unwrap();
        assert_eq!(meta.workspace_id, canonical.display().to_string());
    }

    #[test]
    fn cloud_identifier_rejects_an_unknown_root() {
        let f = Fixture::new();
        for bad in [
            "axe-cloud://axe-cloud/other",
            "axe-cloud://axe-cloud/work2",
            "axe-cloud://axe-cloud",
            "axe-cloud://axe-cloud/",
            "axe-cloud://",
        ] {
            assert!(f.create(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn cloud_identifier_rejects_traversal() {
        let f = Fixture::new();
        for bad in [
            "axe-cloud://axe-cloud/work/..",
            "axe-cloud://axe-cloud/work/../etc",
            "axe-cloud://axe-cloud/work/./portail",
            "axe-cloud://axe-cloud/work/a/../../etc",
        ] {
            assert!(f.create(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn cloud_identifier_requires_a_configured_root() {
        let base = std::env::temp_dir().join(format!("l7-sessions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let daemon = Daemon::new(
            crate::DaemonConfig::new(base.join("data")),
            Arc::new(EchoFactory),
        );
        let request = CreateSessionRequest {
            name: "l7".into(),
            workspace_id: "axe-cloud://axe-cloud/work".into(),
            model: ModelRef::new("test", "echo"),
            parent_id: None,
            system_prompt_extra: None,
            initial_message: None,
        };
        assert!(daemon.create(request).is_err());
        drop(daemon);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// axe:e3 — archiver sort la conversation des actives ; la suppression
    /// n'est possible qu'à partir de l'archive.
    #[test]
    fn archiver_puis_supprimer_depuis_l_archive() {
        let f = Fixture::new();
        let gardee = f.create("axe-cloud://axe-cloud/work").unwrap();
        let partie = f.create("axe-cloud://axe-cloud/work").unwrap();
        let daemon = f.daemon.as_ref().unwrap();

        // Sans archivage préalable : refus.
        assert!(
            daemon.delete_archived(&gardee.id).is_err(),
            "suppression acceptée sans archivage"
        );

        let archivee = daemon.archive(&partie.id).unwrap();
        assert_eq!(archivee["id"], partie.id);
        assert_eq!(archivee["state"], "archive");
        assert!(
            daemon.meta(&partie.id).is_err(),
            "la conversation est encore active après archivage"
        );
        assert!(daemon.list_metas().iter().any(|m| m.id == gardee.id));
        assert!(!daemon.list_metas().iter().any(|m| m.id == partie.id));
        assert!(daemon.archive(&partie.id).is_err(), "archivage deux fois");

        let supprimee = daemon.delete_archived(&partie.id).unwrap();
        assert_eq!(supprimee["state"], "supprime");
        assert!(
            daemon.delete_archived(&partie.id).is_err(),
            "suppression acceptée deux fois"
        );
    }

    /// axe:e3 — archiver un fil archive aussi ce qui en découle : aucun enfant
    /// orphelin ne reste dans les conversations actives.
    #[test]
    fn archiver_un_fil_archive_les_enfants() {
        let f = Fixture::new();
        let parent = f.create("axe-cloud://axe-cloud/work").unwrap();
        let daemon = f.daemon.as_ref().unwrap();
        let enfant = daemon
            .create(CreateSessionRequest {
                name: "enfant".into(),
                workspace_id: parent.workspace_id.clone(),
                model: ModelRef::new("test", "echo"),
                parent_id: Some(parent.id.clone()),
                system_prompt_extra: None,
                initial_message: None,
            })
            .unwrap();
        assert!(
            daemon
                .meta(&parent.id)
                .unwrap()
                .children
                .contains(&enfant.id),
            "le lien parent/enfant n'est pas établi"
        );

        daemon.archive(&parent.id).unwrap();
        assert!(daemon.meta(&parent.id).is_err());
        assert!(
            daemon.meta(&enfant.id).is_err(),
            "l'enfant est resté dans les conversations actives"
        );
        assert_eq!(
            daemon
                .list_archived_entries()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );

        // Le rétablissement ramène le parent et son enfant.
        daemon.restore_archived(&parent.id).unwrap();
        daemon.restore_archived(&enfant.id).unwrap();
        assert_eq!(daemon.meta(&parent.id).unwrap().children, vec![enfant.id.clone()]);
    }

    /// axe:e3 — une conversation archivée peut être rétablie : elle revient
    /// dans la liste active, et peut de nouveau être archivée puis supprimée.
    #[test]
    fn retablir_une_conversation_archivee() {
        let f = Fixture::new();
        let conversation = f.create("axe-cloud://axe-cloud/work").unwrap();
        let daemon = f.daemon.as_ref().unwrap();
        daemon.archive(&conversation.id).unwrap();

        // Rien à rétablir pour une conversation restée active.
        let active = f.create("axe-cloud://axe-cloud/work").unwrap();
        assert!(
            daemon.restore_archived(&active.id).is_err(),
            "rétablissement d'une conversation active accepté"
        );

        let rendu = daemon.restore_archived(&conversation.id).unwrap();
        assert_eq!(rendu["state"], "actif");
        assert!(
            daemon.meta(&conversation.id).is_ok(),
            "la conversation n'est pas revenue en mémoire"
        );
        assert!(daemon.list_metas().iter().any(|m| m.id == conversation.id));
        assert!(daemon
            .list_archived_entries()
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());

        // Elle repasse par l'archive, puis se supprime.
        daemon.archive(&conversation.id).unwrap();
        daemon.delete_archived(&conversation.id).unwrap();
    }

    /// axe:e3 — la liste des archives ne laisse fuir aucun chemin de fichier.
    #[test]
    fn la_liste_des_archives_ne_montre_aucun_chemin() {
        let f = Fixture::new();
        let conversation = f.create("axe-cloud://axe-cloud/work").unwrap();
        let daemon = f.daemon.as_ref().unwrap();
        daemon.archive(&conversation.id).unwrap();

        let archives = daemon.list_archived_entries().unwrap();
        let liste = archives.as_array().unwrap();
        assert_eq!(liste.len(), 1);
        assert_eq!(liste[0]["id"], conversation.id);
        assert_eq!(liste[0]["state"], "archive");
        let texte = archives.to_string();
        assert!(
            !texte.contains("archive/"),
            "un chemin d'archive fuit : {texte}"
        );
        assert!(
            !texte.contains(".jsonl"),
            "un nom de fichier fuit : {texte}"
        );
    }

    /// axe:e3 — un identifiant ne peut pas sortir du dossier d'archive.
    #[test]
    fn un_identifiant_ne_sort_pas_du_dossier() {
        let f = Fixture::new();
        let daemon = f.daemon.as_ref().unwrap();
        for mauvais in ["../evade", "a/b", "", "a\\b", &"x".repeat(200)] {
            assert!(daemon.archive(mauvais).is_err(), "accepté : {mauvais:?}");
            assert!(
                daemon.delete_archived(mauvais).is_err(),
                "accepté : {mauvais:?}"
            );
        }
    }

    #[test]
    fn local_paths_are_unchanged() {
        let f = Fixture::new();
        let canonical = std::fs::canonicalize(&f.root).unwrap();
        let meta = f.create(&f.root.display().to_string()).unwrap();
        assert_eq!(meta.workspace_id, canonical.display().to_string());

        // Un chemin relatif reste relatif à la racine.
        std::fs::create_dir_all(f.root.join("rel")).unwrap();
        let rel = std::fs::canonicalize(f.root.join("rel")).unwrap();
        let meta = f.create("rel").unwrap();
        assert_eq!(meta.workspace_id, rel.display().to_string());
    }
}
