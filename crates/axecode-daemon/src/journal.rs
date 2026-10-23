//! Append-only JSONL journal: one file per session in `data/sessions/<id>.jsonl`.
//!
//! Every entry carries an id, a parent id and a timestamp. The "leaf" is the
//! entry the next one attaches to; branches, forks and clones are expressed
//! by moving the leaf (a `Pointer` entry) inside the same file.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use flate2::{read::GzDecoder, write::GzEncoder, Compression};

use axecode_core::{
    ChatMessage, EntryId, JournalBranch, JournalEntry, JournalEntryKind, JournalTree, ModelRef,
    PeerMessage, Role, SessionError, SessionId, SessionMeta, SessionResult, SessionStatus,
};

use crate::util::{new_id, now_ms};

pub const SESSIONS_DIR: &str = "sessions";
/// axe:e3 — conversations archivées. Chemin jamais montré à l'utilisateur.
pub const ARCHIVE_DIR: &str = "archive";

/// In-memory handle on one session journal.
#[derive(Debug)]
pub struct Journal {
    session_id: SessionId,
    path: PathBuf,
    entries: Vec<JournalEntry>,
    index: HashMap<EntryId, usize>,
    leaf: Option<EntryId>,
    /// axe:menage — read from a compressed archive: never written.
    read_only: bool,
}

pub fn sessions_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SESSIONS_DIR)
}

pub fn journal_path(data_dir: &Path, session_id: &str) -> PathBuf {
    sessions_dir(data_dir).join(format!("{session_id}.jsonl"))
}

pub fn snapshot_path(data_dir: &Path, session_id: &str) -> PathBuf {
    sessions_dir(data_dir).join(format!("{session_id}.snapshot"))
}

/// axe:e3 — dossier d'archive (sous les données du service, jamais affiché).
pub fn archive_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(ARCHIVE_DIR)
}

/// axe:e3 — journal d'une conversation archivée.
pub fn archive_path(data_dir: &Path, session_id: &str) -> PathBuf {
    archive_dir(data_dir).join(format!("{session_id}.jsonl"))
}

/// axe:e3 — snapshot de kernel d'une conversation archivée.
pub fn archive_snapshot_path(data_dir: &Path, session_id: &str) -> PathBuf {
    archive_dir(data_dir).join(format!("{session_id}.snapshot"))
}

/// axe:menage — compressed form of an archived file (`<name>.gz`).
pub fn gz_path(path: &Path) -> PathBuf {
    with_suffix(path, ".gz")
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// axe:menage — whether an archive exists for this session (plain or `.gz`).
pub fn archive_exists(data_dir: &Path, session_id: &str) -> bool {
    let plain = archive_path(data_dir, session_id);
    plain.exists() || gz_path(&plain).exists()
}

/// axe:menage — reader on an archived journal, plain or compressed. The
/// plain file wins when both exist: it is never older than the `.gz`.
fn archive_reader(data_dir: &Path, session_id: &str) -> io::Result<(PathBuf, Box<dyn BufRead>)> {
    let plain = archive_path(data_dir, session_id);
    match File::open(&plain) {
        Ok(file) => return Ok((plain, Box::new(BufReader::new(file)))),
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        Err(_) => {}
    }
    let gz = gz_path(&plain);
    let file = File::open(&gz)?;
    Ok((gz, Box::new(BufReader::new(GzDecoder::new(BufReader::new(file))))))
}

/// axe:menage — metadata of an archived session read from its first
/// entries only (no full read, even compressed): enough for the family view
/// of the runtimes. `updated_at_ms` is the date of the file; a rename or a
/// model switch made after the creation is not seen. `None`: unreadable.
pub fn archived_head(data_dir: &Path, session_id: &str) -> Option<SessionMeta> {
    let (path, reader) = archive_reader(data_dir, session_id).ok()?;
    let mut lines = reader
        .lines()
        .map_while(Result::ok)
        .filter(|line| !line.trim().is_empty());
    let root: JournalEntry = serde_json::from_str(lines.next()?.trim()).ok()?;
    let created = match &root.kind {
        // A fork carries its own SessionCreated right after the Fork entry.
        JournalEntryKind::Fork { .. } => serde_json::from_str(lines.next()?.trim()).ok()?,
        _ => root.clone(),
    };
    let JournalEntryKind::SessionCreated {
        name,
        workspace_id,
        model,
        parent_id,
        system_prompt_extra,
    } = created.kind
    else {
        return None;
    };
    let file_ms = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(root.ts, |d| d.as_millis() as i64);
    Some(SessionMeta {
        id: session_id.to_string(),
        parent_id,
        name,
        scratch: crate::scratch::is_scratch(data_dir, &workspace_id),
        workspace_id,
        model,
        system_prompt_extra,
        status: SessionStatus::Inactive,
        created_at_ms: root.ts,
        updated_at_ms: file_ms.max(root.ts),
        children: Vec::new(),
        leaf: None,
        entry_count: 0,
        archived: true,
        imported_from: None,
    })
}

/// axe:menage — parent of an archived session (`None`: not a sub-agent, or
/// unreadable).
pub fn archived_parent(data_dir: &Path, session_id: &str) -> Option<SessionId> {
    archived_head(data_dir, session_id)?.parent_id
}

/// axe:menage — opens an archived journal, plain or compressed. A journal
/// read from a `.gz` refuses any append ([`inflate_archive`] first).
pub fn open_archived(data_dir: &Path, session_id: &str) -> SessionResult<Journal> {
    let (path, reader) = match archive_reader(data_dir, session_id) {
        Ok(found) => found,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Err(SessionError::NotFound(session_id.to_string()))
        }
        Err(err) => return Err(err.into()),
    };
    let compressed = path.extension().is_some_and(|ext| ext == "gz");
    let journal = Journal::from_reader(&path, session_id.to_string(), reader, compressed);
    if let Err(err) = &journal {
        tracing::warn!(file = %path.display(), error = %err, "unreadable archive (kept as is)");
    }
    journal
}

/// axe:e3 — identifiants des conversations archivées sur disque
/// (axe:menage : `<id>.jsonl` ou `<id>.jsonl.gz`).
pub fn list_archived_ids(data_dir: &Path) -> Vec<SessionId> {
    let Ok(read) = fs::read_dir(archive_dir(data_dir)) else {
        return Vec::new();
    };
    let mut ids: Vec<SessionId> = read
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().to_string_lossy().to_string();
            let id = name
                .strip_suffix(".jsonl")
                .or_else(|| name.strip_suffix(".jsonl.gz"))?;
            (!id.is_empty()).then(|| id.to_string())
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

// ----- axe:menage — compression of old archives ----------------------------

/// Result of a compression pass.
#[derive(Debug, Default)]
pub struct CompressReport {
    /// `.gz` files written (their original removed).
    pub compressed: Vec<PathBuf>,
    /// One line per file left as is.
    pub errors: Vec<String>,
}

/// Archived files (`<id>.jsonl`, `<id>.snapshot`) untouched for `older_than`.
pub fn archives_to_compress(data_dir: &Path, older_than: Duration) -> Vec<PathBuf> {
    let Ok(read) = fs::read_dir(archive_dir(data_dir)) else {
        return Vec::new();
    };
    let now = SystemTime::now();
    let mut out: Vec<PathBuf> = read
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !(name.ends_with(".jsonl") || name.ends_with(".snapshot")) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let age = now.duration_since(meta.modified().ok()?).ok()?;
            (meta.is_file() && age >= older_than).then(|| entry.path())
        })
        .collect();
    out.sort();
    out
}

/// Temporary files of an interrupted compression or decompression. Never
/// the only copy: an original is removed only after its copy is complete.
pub fn remove_stale_tmp(data_dir: &Path) {
    let Ok(read) = fs::read_dir(archive_dir(data_dir)) else {
        return;
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let ours = [".jsonl.gz.tmp", ".snapshot.gz.tmp", ".jsonl.tmp", ".snapshot.tmp"]
            .iter()
            .any(|suffix| name.ends_with(suffix));
        if ours && entry.path().is_file() {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Fills `buf` as far as the reader allows (0 = end of stream).
fn read_full(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

/// Whether the `.gz` file decompresses to exactly the plain file (the gzip
/// checksum is checked at the end of the stream).
fn same_content(plain: &Path, gz: &Path) -> io::Result<bool> {
    let mut a = BufReader::new(File::open(plain)?);
    let mut b = GzDecoder::new(BufReader::new(File::open(gz)?));
    let mut buf_a = vec![0u8; 64 * 1024];
    let mut buf_b = vec![0u8; 64 * 1024];
    loop {
        let n = read_full(&mut a, &mut buf_a)?;
        let m = read_full(&mut b, &mut buf_b)?;
        if n != m || buf_a[..n] != buf_b[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// Compresses one archived file: written to `<name>.gz.tmp`, checked
/// against the original, renamed to `<name>.gz`; only then is the original
/// removed. On any error the original stays and the temporary file goes.
pub fn compress_archive_file(path: &Path) -> io::Result<PathBuf> {
    let before = fs::metadata(path)?;
    let gz = gz_path(path);
    let tmp = with_suffix(&gz, ".tmp");
    let result = (|| -> io::Result<()> {
        {
            let mut input = BufReader::new(File::open(path)?);
            let mut encoder = GzEncoder::new(BufWriter::new(File::create(&tmp)?), Compression::default());
            io::copy(&mut input, &mut encoder)?;
            let file = encoder.finish()?.into_inner().map_err(|e| e.into_error())?;
            file.sync_all()?;
        }
        if !same_content(path, &tmp)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the compressed copy differs from the original",
            ));
        }
        let after = fs::metadata(path)?;
        if after.len() != before.len() || after.modified().ok() != before.modified().ok() {
            return Err(io::Error::other("archive modified during its compression"));
        }
        // The archive keeps its age (best effort).
        if let Ok(modified) = before.modified() {
            if let Ok(file) = File::options().write(true).open(&tmp) {
                let _ = file.set_modified(modified);
            }
        }
        fs::rename(&tmp, &gz)
    })();
    if let Err(err) = result {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    fs::remove_file(path)?;
    Ok(gz)
}

/// Brings an archived file back to its plain form when only its `.gz`
/// exists. The `.gz` is removed only once the plain copy is complete (gzip
/// checksum checked); a corrupted `.gz` gives an error, logged, and stays on
/// disk untouched. True when a file was decompressed.
pub fn inflate_file(plain: &Path) -> io::Result<bool> {
    let gz = gz_path(plain);
    if plain.exists() || !gz.exists() {
        return Ok(false);
    }
    let tmp = with_suffix(plain, ".tmp");
    let result = (|| -> io::Result<()> {
        let modified = fs::metadata(&gz)?.modified().ok();
        {
            let mut decoder = GzDecoder::new(BufReader::new(File::open(&gz)?));
            let mut out = BufWriter::new(File::create(&tmp)?);
            io::copy(&mut decoder, &mut out)?;
            let file = out.into_inner().map_err(|e| e.into_error())?;
            file.sync_all()?;
            if let Some(modified) = modified {
                let _ = file.set_modified(modified);
            }
        }
        fs::rename(&tmp, plain)
    })();
    if let Err(err) = result {
        let _ = fs::remove_file(&tmp);
        tracing::warn!(file = %gz.display(), error = %err, "unreadable compressed archive (kept as is)");
        return Err(err);
    }
    if let Err(err) = fs::remove_file(&gz) {
        tracing::warn!(file = %gz.display(), error = %err, "decompressed archive: .gz not removed");
    }
    Ok(true)
}

/// Decompresses the archive of a session before its restoration. The
/// journal must come back (error otherwise); a kernel snapshot that cannot
/// be read stays compressed in the archive, and the session restarts with a
/// fresh kernel.
pub fn inflate_archive(data_dir: &Path, session_id: &str) -> SessionResult<()> {
    inflate_file(&archive_path(data_dir, session_id))
        .map_err(|err| SessionError::Io(format!("compressed archive unreadable: {err}")))?;
    if let Err(err) = inflate_file(&archive_snapshot_path(data_dir, session_id)) {
        tracing::warn!(session = %session_id, error = %err, "kernel snapshot left compressed in the archive");
    }
    Ok(())
}

/// Every file of an archived session, plain and compressed.
pub fn archive_files(data_dir: &Path, session_id: &str) -> [PathBuf; 4] {
    let journal = archive_path(data_dir, session_id);
    let snapshot = archive_snapshot_path(data_dir, session_id);
    [gz_path(&journal), gz_path(&snapshot), journal, snapshot]
}

impl Journal {
    /// Creates a new journal file and writes the root entry.
    pub fn create(
        data_dir: &Path,
        session_id: &str,
        root: JournalEntryKind,
    ) -> SessionResult<Self> {
        let path = journal_path(data_dir, session_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        if path.exists() {
            return Err(SessionError::Journal(format!(
                "journal already exists for session {session_id}"
            )));
        }
        File::create(&path)?;
        let mut journal = Self {
            session_id: session_id.to_string(),
            path,
            entries: Vec::new(),
            index: HashMap::new(),
            leaf: None,
            read_only: false,
        };
        journal.append(root)?;
        Ok(journal)
    }

    /// Opens an existing journal and replays it to rebuild the index and leaf.
    pub fn open(data_dir: &Path, session_id: &str) -> SessionResult<Self> {
        Self::open_path(&journal_path(data_dir, session_id))
    }

    /// axe:e3 — opens a journal from an explicit path (active or archive).
    pub fn open_path(path: &Path) -> SessionResult<Self> {
        let session_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let file = File::open(path).map_err(|_| SessionError::NotFound(session_id.clone()))?;
        Self::from_reader(path, session_id, Box::new(BufReader::new(file)), false)
    }

    /// Replays a journal from any reader (axe:menage: plain file or `.gz`).
    /// `read_only` journals refuse every append.
    fn from_reader(
        path: &Path,
        session_id: SessionId,
        reader: Box<dyn BufRead>,
        read_only: bool,
    ) -> SessionResult<Self> {
        let mut journal = Self {
            session_id,
            path: path.to_path_buf(),
            entries: Vec::new(),
            index: HashMap::new(),
            leaf: None,
            read_only,
        };
        for (line_no, line) in reader.lines().enumerate() {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<JournalEntry>(trimmed) {
                Ok(entry) => journal.index_entry(entry),
                Err(err) => {
                    // A truncated last line (crash mid-write) is tolerated;
                    // anything else is reported but does not block loading.
                    tracing::warn!(
                        session = %journal.session_id,
                        line = line_no + 1,
                        error = %err,
                        "skipping unreadable journal line"
                    );
                }
            }
        }
        if journal.entries.is_empty() {
            return Err(SessionError::Journal(format!(
                "journal for session {} is empty",
                journal.session_id
            )));
        }
        Ok(journal)
    }

    pub fn exists(data_dir: &Path, session_id: &str) -> bool {
        journal_path(data_dir, session_id).exists()
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn leaf(&self) -> Option<&EntryId> {
        self.leaf.as_ref()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> &[JournalEntry] {
        &self.entries
    }

    pub fn get(&self, id: &str) -> Option<&JournalEntry> {
        self.index.get(id).map(|&i| &self.entries[i])
    }

    fn index_entry(&mut self, entry: JournalEntry) {
        match &entry.kind {
            JournalEntryKind::Pointer { leaf, .. } => {
                if self.index.contains_key(leaf) {
                    self.leaf = Some(leaf.clone());
                }
            }
            _ => self.leaf = Some(entry.id.clone()),
        }
        self.index.insert(entry.id.clone(), self.entries.len());
        self.entries.push(entry);
    }

    /// Appends an entry attached to the current leaf and flushes it to disk
    /// immediately. Returns the new entry id.
    pub fn append(&mut self, kind: JournalEntryKind) -> SessionResult<EntryId> {
        if self.read_only {
            return Err(SessionError::Journal(format!(
                "compressed archive of {} is read only",
                self.session_id
            )));
        }
        let parent = match &kind {
            // Pointer entries attach to the entry they point to.
            JournalEntryKind::Pointer { leaf, .. } => {
                if !self.index.contains_key(leaf) {
                    return Err(SessionError::Journal(format!("unknown entry {leaf}")));
                }
                Some(leaf.clone())
            }
            _ => self.leaf.clone(),
        };
        let entry = JournalEntry {
            id: new_id(),
            parent,
            ts: now_ms(),
            kind,
        };
        let mut line = serde_json::to_string(&entry)?;
        line.push('\n');
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        file.flush()?;
        let id = entry.id.clone();
        self.index_entry(entry);
        Ok(id)
    }

    /// Moves the leaf to `entry_id` (branch / undo). Journaled as a Pointer.
    pub fn move_leaf(&mut self, entry_id: &str, label: Option<String>) -> SessionResult<EntryId> {
        self.append(JournalEntryKind::Pointer {
            leaf: entry_id.to_string(),
            label,
        })
    }

    /// Linear path from the root to the current leaf (oldest first).
    pub fn path_to_leaf(&self) -> Vec<&JournalEntry> {
        self.path_to(self.leaf.as_deref())
    }

    pub fn path_to(&self, entry_id: Option<&str>) -> Vec<&JournalEntry> {
        let mut path = Vec::new();
        let mut cursor = entry_id.and_then(|id| self.get(id));
        let mut guard = self.entries.len() + 1;
        while let Some(entry) = cursor {
            path.push(entry);
            cursor = entry.parent.as_deref().and_then(|id| self.get(id));
            guard -= 1;
            if guard == 0 {
                break;
            }
        }
        path.reverse();
        path
    }

    /// Rebuilds the chat transcript along the current branch, applying
    /// compactions (a compaction collapses the entries between `from_entry`
    /// and `to_entry` on the path into a single user-visible summary).
    pub fn history(&self) -> Vec<ChatMessage> {
        history_from_path(&self.path_to_leaf())
    }

    /// Peer messages on the current branch that have not been acknowledged
    /// by a `PeerDelivered` entry.
    pub fn pending_peer_messages(&self) -> Vec<PeerMessage> {
        let mut delivered: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for entry in &self.entries {
            if let JournalEntryKind::PeerDelivered { entry_ids } = &entry.kind {
                delivered.extend(entry_ids.iter().map(String::as_str));
            }
        }
        self.entries
            .iter()
            .filter_map(|entry| match &entry.kind {
                JournalEntryKind::PeerMessage { from_session, text }
                    if !delivered.contains(entry.id.as_str()) =>
                {
                    Some(PeerMessage {
                        entry_id: entry.id.clone(),
                        from_session: from_session.clone(),
                        text: text.clone(),
                        ts: entry.ts,
                    })
                }
                _ => None,
            })
            .collect()
    }

    /// Full tree view for `/tree`.
    pub fn tree(&self) -> JournalTree {
        let branches = self
            .entries
            .iter()
            .filter_map(|entry| match &entry.kind {
                JournalEntryKind::Pointer { leaf, label } => Some(JournalBranch {
                    leaf: leaf.clone(),
                    label: label.clone(),
                    ts: entry.ts,
                }),
                _ => None,
            })
            .collect();
        JournalTree {
            session_id: self.session_id.clone(),
            leaf: self.leaf.clone(),
            entries: self.entries.clone(),
            branches,
        }
    }

    /// Rebuilds session metadata from the journal (used when the index is
    /// missing or stale).
    pub fn rebuild_meta(&self) -> Option<SessionMeta> {
        let root = self.entries.first()?;
        let mut meta = match &root.kind {
            JournalEntryKind::SessionCreated {
                name,
                workspace_id,
                model,
                parent_id,
                system_prompt_extra,
            } => SessionMeta {
                id: self.session_id.clone(),
                parent_id: parent_id.clone(),
                name: name.clone(),
                workspace_id: workspace_id.clone(),
                model: model.clone(),
                system_prompt_extra: system_prompt_extra.clone(),
                status: SessionStatus::Inactive,
                created_at_ms: root.ts,
                updated_at_ms: root.ts,
                children: Vec::new(),
                leaf: None,
                entry_count: 0,
                archived: false,
                imported_from: None,
                scratch: false,
            },
            JournalEntryKind::Fork { .. } => {
                // Forks carry their own SessionCreated right after the Fork entry.
                let created = self.entries.get(1)?;
                let JournalEntryKind::SessionCreated {
                    name,
                    workspace_id,
                    model,
                    parent_id,
                    system_prompt_extra,
                } = &created.kind
                else {
                    return None;
                };
                SessionMeta {
                    id: self.session_id.clone(),
                    parent_id: parent_id.clone(),
                    name: name.clone(),
                    workspace_id: workspace_id.clone(),
                    model: model.clone(),
                    system_prompt_extra: system_prompt_extra.clone(),
                    status: SessionStatus::Inactive,
                    created_at_ms: root.ts,
                    updated_at_ms: root.ts,
                    children: Vec::new(),
                    leaf: None,
                    entry_count: 0,
                    archived: false,
                    imported_from: None,
                    scratch: false,
                }
            }
            _ => return None,
        };
        for entry in &self.entries {
            meta.updated_at_ms = meta.updated_at_ms.max(entry.ts);
            match &entry.kind {
                JournalEntryKind::ModelSwitch { to, .. } => meta.model = to.clone(),
                JournalEntryKind::Meta {
                    name,
                    archived,
                    workspace_id,
                    system_prompt_extra,
                } => {
                    if let Some(name) = name {
                        meta.name = name.clone();
                    }
                    if let Some(archived) = archived {
                        meta.archived = *archived;
                    }
                    // axe:freechat
                    if let Some(workspace_id) = workspace_id {
                        meta.workspace_id = workspace_id.clone();
                    }
                    if let Some(extra) = system_prompt_extra {
                        meta.system_prompt_extra = Some(extra.clone()).filter(|e| !e.is_empty());
                    }
                }
                JournalEntryKind::Extension { name, payload } if name == "imported_from" => {
                    meta.imported_from = payload.as_str().map(str::to_string);
                }
                _ => {}
            }
        }
        meta.leaf = self.leaf.clone();
        meta.entry_count = self.entries.len();
        // axe:freechat
        meta.scratch = crate::scratch::data_dir_of_journal(&self.path)
            .is_some_and(|data_dir| crate::scratch::is_scratch(data_dir, &meta.workspace_id));
        Some(meta)
    }

    /// Current model along the branch (last ModelSwitch or the root model).
    pub fn current_model(&self) -> Option<ModelRef> {
        let path = self.path_to_leaf();
        let mut model = None;
        for entry in path {
            match &entry.kind {
                JournalEntryKind::SessionCreated { model: m, .. } => model = Some(m.clone()),
                JournalEntryKind::ModelSwitch { to, .. } => model = Some(to.clone()),
                _ => {}
            }
        }
        model
    }

    /// Writes a fork of this journal into a new session file: the new file
    /// starts with a `Fork` root, then a `SessionCreated`, then a copy of the
    /// path up to `source_entry` so the child is self-contained.
    pub fn fork(
        &self,
        data_dir: &Path,
        new_session_id: &str,
        source_entry: &str,
        created: JournalEntryKind,
    ) -> SessionResult<Journal> {
        if !self.index.contains_key(source_entry) {
            return Err(SessionError::Journal(format!(
                "unknown entry {source_entry}"
            )));
        }
        let mut child = Journal::create(
            data_dir,
            new_session_id,
            JournalEntryKind::Fork {
                source_session: self.session_id.clone(),
                source_entry: source_entry.to_string(),
            },
        )?;
        let mut derniere = child.append(created)?;
        // axe:arriere-plan — une compaction copiée désigne des entrées de la
        // source : ses bornes sont réécrites vers les entrées du clone (sinon
        // `history_from_path` l'ignorait et le clone repartait de tout
        // l'historique). Une borne posée sur une entrée non copiée (racine,
        // pointeur, méta) prend la première entrée copiée après elle (début)
        // ou la dernière copiée avant elle (fin).
        let mut debut: HashMap<EntryId, EntryId> = HashMap::new();
        let mut fin: HashMap<EntryId, EntryId> = HashMap::new();
        let mut en_attente: Vec<EntryId> = Vec::new();
        for entry in self.path_to(Some(source_entry)) {
            let kind = match &entry.kind {
                JournalEntryKind::SessionCreated { .. }
                | JournalEntryKind::Fork { .. }
                | JournalEntryKind::Pointer { .. }
                | JournalEntryKind::Meta { .. } => {
                    en_attente.push(entry.id.clone());
                    fin.insert(entry.id.clone(), derniere.clone());
                    continue;
                }
                JournalEntryKind::Compaction {
                    summary,
                    from_entry,
                    to_entry,
                    directive,
                } => JournalEntryKind::Compaction {
                    summary: summary.clone(),
                    from_entry: debut.get(from_entry).cloned().unwrap_or_else(|| from_entry.clone()),
                    to_entry: fin.get(to_entry).cloned().unwrap_or_else(|| to_entry.clone()),
                    directive: directive.clone(),
                },
                kind => kind.clone(),
            };
            let id = child.append(kind)?;
            for attente in en_attente.drain(..) {
                debut.insert(attente, id.clone());
            }
            debut.insert(entry.id.clone(), id.clone());
            fin.insert(entry.id.clone(), id.clone());
            derniere = id;
        }
        Ok(child)
    }
}

/// Builds the transcript from a linear path of entries. Compaction entries
/// replace the range they cover.
pub fn history_from_path(path: &[&JournalEntry]) -> Vec<ChatMessage> {
    let position: HashMap<&str, usize> = path
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), i))
        .collect();

    // For each range start, the compaction reaching furthest: successive
    // compactions share their `from_entry` and the latest covers the others.
    let mut skip_from: HashMap<usize, (usize, &str)> = HashMap::new();
    for entry in path {
        if let JournalEntryKind::Compaction {
            summary,
            from_entry,
            to_entry,
            ..
        } = &entry.kind
        {
            let (Some(&f), Some(&t)) = (
                position.get(from_entry.as_str()),
                position.get(to_entry.as_str()),
            ) else {
                continue;
            };
            if f <= t && skip_from.get(&f).map_or(true, |&(until, _)| t > until) {
                skip_from.insert(f, (t, summary.as_str()));
            }
        }
    }

    let mut history: Vec<ChatMessage> = Vec::new();
    let mut skip_until: Option<usize> = None;

    for (i, entry) in path.iter().enumerate() {
        if let Some(until) = skip_until {
            if i <= until {
                continue;
            }
            skip_until = None;
        }
        if let Some((until, summary)) = skip_from.get(&i) {
            history.push(ChatMessage::user_text(format!(
                "<compacted_history>\n{summary}\n</compacted_history>"
            )));
            skip_until = Some(*until);
            continue;
        }
        match &entry.kind {
            JournalEntryKind::Message { message, .. } => history.push(message.clone()),
            JournalEntryKind::ReplCall { call_id, code, .. } => {
                push_part(
                    &mut history,
                    Role::Assistant,
                    axecode_core::Part::ToolCall {
                        id: call_id.clone(),
                        name: "python".into(),
                        input: serde_json::json!({ "code": code }),
                        meta: None,
                    },
                );
            }
            JournalEntryKind::ReplResult {
                call_id,
                output,
                is_error,
                images,
                ..
            } => {
                push_part(
                    &mut history,
                    Role::User,
                    axecode_core::Part::ToolResult {
                        tool_call_id: call_id.clone(),
                        content: output.clone(),
                        images: images.clone(),
                        is_error: *is_error,
                        meta: None,
                    },
                );
            }
            _ => {}
        }
    }
    history
}

fn push_part(history: &mut Vec<ChatMessage>, role: Role, part: axecode_core::Part) {
    match history.last_mut() {
        Some(last) if last.role == role && merges_with(&last.parts, &part) => last.parts.push(part),
        _ => history.push(ChatMessage {
            role,
            parts: vec![part],
        }),
    }
}

fn merges_with(existing: &[axecode_core::Part], incoming: &axecode_core::Part) -> bool {
    use axecode_core::Part;
    match incoming {
        Part::ToolCall { .. } => existing.iter().all(|p| {
            matches!(
                p,
                Part::ToolCall { .. } | Part::Text { .. } | Part::Thinking { .. }
            )
        }),
        Part::ToolResult { .. } => existing
            .iter()
            .all(|p| matches!(p, Part::ToolResult { .. })),
        _ => false,
    }
}

/// Lists session ids present on disk.
pub fn list_journal_ids(data_dir: &Path) -> Vec<SessionId> {
    let Ok(read) = fs::read_dir(sessions_dir(data_dir)) else {
        return Vec::new();
    };
    read.filter_map(|entry| {
        let path = entry.ok()?.path();
        if path.extension()? != "jsonl" {
            return None;
        }
        Some(path.file_stem()?.to_string_lossy().to_string())
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axecode_core::ChatMessage;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("axecode-journal-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn created() -> JournalEntryKind {
        JournalEntryKind::SessionCreated {
            name: "test".into(),
            workspace_id: "ws".into(),
            model: ModelRef::new("anthropic", "x"),
            parent_id: None,
            system_prompt_extra: None,
        }
    }

    #[test]
    fn append_reopen_and_branch() {
        let dir = tmp();
        let mut j = Journal::create(&dir, "s1", created()).unwrap();
        let m1 = j
            .append(JournalEntryKind::Message {
                message: ChatMessage::user_text("hello"),
                usage: None,
                turn_id: None,
            })
            .unwrap();
        j.append(JournalEntryKind::Message {
            message: ChatMessage::assistant_text("hi"),
            usage: None,
            turn_id: None,
        })
        .unwrap();
        assert_eq!(j.history().len(), 2);

        j.move_leaf(&m1, Some("branch".into())).unwrap();
        j.append(JournalEntryKind::Message {
            message: ChatMessage::assistant_text("other"),
            usage: None,
            turn_id: None,
        })
        .unwrap();
        let h = j.history();
        assert_eq!(h.len(), 2);
        assert_eq!(h[1].text(), "other");

        let reopened = Journal::open(&dir, "s1").unwrap();
        assert_eq!(reopened.len(), 5);
        assert_eq!(reopened.history()[1].text(), "other");
        assert_eq!(reopened.tree().branches.len(), 1);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn compaction_collapses_range() {
        let dir = tmp();
        let mut j = Journal::create(&dir, "s2", created()).unwrap();
        let a = j
            .append(JournalEntryKind::Message {
                message: ChatMessage::user_text("a"),
                usage: None,
                turn_id: None,
            })
            .unwrap();
        let b = j
            .append(JournalEntryKind::Message {
                message: ChatMessage::assistant_text("b"),
                usage: None,
                turn_id: None,
            })
            .unwrap();
        j.append(JournalEntryKind::Compaction {
            summary: "sum".into(),
            from_entry: a,
            to_entry: b,
            directive: None,
        })
        .unwrap();
        j.append(JournalEntryKind::Message {
            message: ChatMessage::user_text("c"),
            usage: None,
            turn_id: None,
        })
        .unwrap();
        let h = j.history();
        assert_eq!(h.len(), 2);
        assert!(h[0].text().contains("sum"));
        assert_eq!(h[1].text(), "c");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn fork_copies_path() {
        let dir = tmp();
        let mut j = Journal::create(&dir, "s3", created()).unwrap();
        let a = j
            .append(JournalEntryKind::Message {
                message: ChatMessage::user_text("a"),
                usage: None,
                turn_id: None,
            })
            .unwrap();
        j.append(JournalEntryKind::Message {
            message: ChatMessage::assistant_text("b"),
            usage: None,
            turn_id: None,
        })
        .unwrap();
        let child = j.fork(&dir, "s3-child", &a, created()).unwrap();
        assert_eq!(child.history().len(), 1);
        let meta = child.rebuild_meta().unwrap();
        assert_eq!(meta.id, "s3-child");
        fs::remove_dir_all(dir).ok();
    }

    /// axe:arriere-plan — une compaction copiée garde son effet dans le clone
    /// (avant : bornes inconnues du clone => historique complet).
    #[test]
    fn fork_garde_la_compaction() {
        let dir = tmp();
        let mut j = Journal::create(&dir, "s4", created()).unwrap();
        let msg = |t: &str| JournalEntryKind::Message {
            message: ChatMessage::user_text(t),
            usage: None,
            turn_id: None,
        };
        // Début de la compaction sur une entrée que le clone ne copie pas.
        let renomme = j
            .append(JournalEntryKind::Meta {
                name: Some("renommée".into()),
                archived: None,
                workspace_id: None,
                system_prompt_extra: None,
            })
            .unwrap();
        j.append(msg("ancien 1")).unwrap();
        let b = j.append(msg("ancien 2")).unwrap();
        j.append(JournalEntryKind::Compaction {
            summary: "RESUME".into(),
            from_entry: renomme,
            to_entry: b,
            directive: None,
        })
        .unwrap();
        let c = j.append(msg("recent")).unwrap();
        let attendu = j.history();
        assert_eq!(attendu.len(), 2, "résumé + message récent");
        let child = j.fork(&dir, "s4-child", &c, created()).unwrap();
        assert_eq!(
            serde_json::to_value(child.history()).unwrap(),
            serde_json::to_value(&attendu).unwrap()
        );
        let texte = serde_json::to_string(&child.history()).unwrap();
        assert!(texte.contains("RESUME") && !texte.contains("ancien 1"));
        fs::remove_dir_all(dir).ok();
    }
}
