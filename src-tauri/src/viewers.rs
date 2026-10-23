// axe:viewers — backend helpers for the multi-format file viewers.
//
// The editor viewers never load a whole binary file through the JSON IPC:
// they ask for byte ranges (`viewer_read_bytes`) that come back as a raw
// `ArrayBuffer`, so large PDFs or hex dumps are streamed chunk by chunk.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::Response;

/// Upper bound for a single range request (the front end loops for more).
const MAX_CHUNK_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ViewerReadBytesInput {
    pub(super) path: String,
    pub(super) offset: u64,
    pub(super) length: u64,
}

fn read_range(path: PathBuf, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    let mut file =
        File::open(&path).map_err(|err| format!("impossible d'ouvrir {} : {err}", path.display()))?;
    let size = file
        .metadata()
        .map_err(|err| format!("impossible de lire les métadonnées : {err}"))?
        .len();
    if offset >= size {
        return Ok(Vec::new());
    }
    let length = length.min(MAX_CHUNK_BYTES).min(size - offset);
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("impossible de se positionner dans le fichier : {err}"))?;
    let mut buffer = Vec::with_capacity(length as usize);
    file.take(length)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("lecture impossible : {err}"))?;
    Ok(buffer)
}

/// Returns `length` bytes of `path` starting at `offset` as a raw buffer.
#[tauri::command]
pub(super) async fn viewer_read_bytes(input: ViewerReadBytesInput) -> Result<Response, String> {
    let path = PathBuf::from(&input.path);
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        read_range(path, input.offset, input.length)
    })
    .await
    .map_err(|err| format!("échec de la lecture pour l'aperçu : {err}"))??;
    Ok(Response::new(bytes))
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|err| format!("échec de l'aperçu : {err}"))?
}

// ---------------------------------------------------------------- zip ----

/// Archives with more entries are listed partially (`truncated`).
const MAX_ZIP_ENTRIES: usize = 50_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ViewerPathInput {
    pub(super) path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ZipEntry {
    name: String,
    size: u64,
    compressed_size: u64,
    is_dir: bool,
    encrypted: bool,
    modified: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ZipListing {
    entries: Vec<ZipEntry>,
    total: usize,
    truncated: bool,
}

fn open_zip(path: &str) -> Result<zip::ZipArchive<File>, String> {
    let file = File::open(path).map_err(|err| format!("impossible d'ouvrir {path} : {err}"))?;
    zip::ZipArchive::new(file).map_err(|err| format!("archive illisible : {err}"))
}

/// Lists the archive content without decompressing anything.
#[tauri::command]
pub(super) async fn viewer_zip_list(input: ViewerPathInput) -> Result<ZipListing, String> {
    blocking(move || {
        let mut archive = open_zip(&input.path)?;
        let total = archive.len();
        let mut entries = Vec::with_capacity(total.min(MAX_ZIP_ENTRIES));
        for index in 0..total.min(MAX_ZIP_ENTRIES) {
            let Ok(file) = archive.by_index_raw(index) else {
                continue;
            };
            entries.push(ZipEntry {
                name: file.name().map(|n| n.into_owned()).unwrap_or_default(),
                size: file.size(),
                compressed_size: file.compressed_size(),
                is_dir: file.is_dir(),
                encrypted: file.encrypted(),
                modified: file.last_modified().map(|d| {
                    format!(
                        "{:04}-{:02}-{:02} {:02}:{:02}",
                        d.year(),
                        d.month(),
                        d.day(),
                        d.hour(),
                        d.minute()
                    )
                }),
            });
        }
        Ok(ZipListing {
            entries,
            total,
            truncated: total > MAX_ZIP_ENTRIES,
        })
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ZipExtractInput {
    pub(super) path: String,
    pub(super) entry: String,
    pub(super) destination: String,
}

/// Extracts one entry to `destination` (chosen by the user in a save dialog).
#[tauri::command]
pub(super) async fn viewer_zip_extract(input: ZipExtractInput) -> Result<u64, String> {
    blocking(move || {
        let mut archive = open_zip(&input.path)?;
        let mut entry = archive
            .by_name(&input.entry)
            .map_err(|err| format!("entrée introuvable ou non prise en charge : {err}"))?;
        if entry.is_dir() {
            return Err("cette entrée est un dossier".to_string());
        }
        let mut out = File::create(&input.destination)
            .map_err(|err| format!("impossible de créer {} : {err}", input.destination))?;
        std::io::copy(&mut entry, &mut out).map_err(|err| format!("extraction impossible : {err}"))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ZipReadInput {
    pub(super) path: String,
    pub(super) entry: String,
}

/// Largest single entry handed to the webview (pptx/epub parts, images).
const MAX_ZIP_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

/// Returns the decompressed bytes of one entry as a raw buffer, so Office
/// and epub viewers read only the parts they need, never the whole archive.
#[tauri::command]
pub(super) async fn viewer_zip_read(input: ZipReadInput) -> Result<Response, String> {
    let bytes = blocking(move || {
        let mut archive = open_zip(&input.path)?;
        let mut entry = archive
            .by_name(&input.entry)
            .map_err(|err| format!("entrée introuvable : {err}"))?;
        if entry.size() > MAX_ZIP_ENTRY_BYTES {
            return Err(format!("entrée trop volumineuse ({} octets)", entry.size()));
        }
        let mut buffer = Vec::with_capacity(entry.size() as usize);
        Read::take(&mut entry, MAX_ZIP_ENTRY_BYTES)
            .read_to_end(&mut buffer)
            .map_err(|err| format!("lecture impossible : {err}"))?;
        Ok(buffer)
    })
    .await?;
    Ok(Response::new(bytes))
}

// ------------------------------------------------------------- sqlite ----

const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const MAX_SQLITE_ROWS: u32 = 1_000;
const MAX_TEXT_CHARS: usize = 2_000;

fn open_sqlite(path: &str) -> Result<rusqlite::Connection, String> {
    let mut magic = [0u8; 16];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .map_err(|_| "Ce fichier n’est pas une base SQLite.".to_string())?;
    if &magic != SQLITE_MAGIC {
        return Err("Ce fichier n’est pas une base SQLite.".to_string());
    }
    // Read-only and query_only: the viewer can never modify the database.
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("ouverture impossible : {err}"))?;
    conn.execute_batch("PRAGMA query_only = ON;")
        .map_err(|err| format!("ouverture impossible : {err}"))?;
    Ok(conn)
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SqliteTable {
    name: String,
    kind: String,
    columns: Vec<String>,
}

/// Tables and views of the database (internal `sqlite_*` tables excluded).
#[tauri::command]
pub(super) async fn viewer_sqlite_tables(input: ViewerPathInput) -> Result<Vec<SqliteTable>, String> {
    blocking(move || {
        let conn = open_sqlite(&input.path)?;
        let mut stmt = conn
            .prepare(
                "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') \
                 AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
            )
            .map_err(|err| err.to_string())?;
        let names = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|err| err.to_string())?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        let mut tables = Vec::with_capacity(names.len());
        for (name, kind) in names {
            let columns = conn
                .prepare(&format!("PRAGMA table_info({})", quote_ident(&name)))
                .and_then(|mut info| {
                    info.query_map([], |row| row.get::<_, String>(1))
                        .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
                })
                .unwrap_or_default();
            tables.push(SqliteTable { name, kind, columns });
        }
        Ok(tables)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SqliteRowsInput {
    pub(super) path: String,
    pub(super) table: String,
    pub(super) limit: u32,
    pub(super) offset: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SqliteRows {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    total: Option<u64>,
}

fn sql_value(value: rusqlite::types::ValueRef<'_>) -> Value {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => Value::Null,
        // Integers beyond 2^53 would lose precision in JS: send them as text.
        ValueRef::Integer(n) if n.unsigned_abs() > (1u64 << 53) => Value::String(n.to_string()),
        ValueRef::Integer(n) => Value::from(n),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            if text.chars().count() > MAX_TEXT_CHARS {
                Value::String(format!("{}…", text.chars().take(MAX_TEXT_CHARS).collect::<String>()))
            } else {
                Value::String(text.into_owned())
            }
        }
        ValueRef::Blob(bytes) => Value::String(format!("<BLOB {} octets>", bytes.len())),
    }
}

/// A page of rows of one table or view, plus its row count.
#[tauri::command]
pub(super) async fn viewer_sqlite_rows(input: SqliteRowsInput) -> Result<SqliteRows, String> {
    blocking(move || {
        let conn = open_sqlite(&input.path)?;
        let table = quote_ident(&input.table);
        let total = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0))
            .ok()
            .map(|n| n.max(0) as u64);
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} LIMIT ?1 OFFSET ?2"))
            .map_err(|err| err.to_string())?;
        let columns = stmt.column_names().into_iter().map(str::to_string).collect::<Vec<_>>();
        let width = columns.len();
        let limit = input.limit.clamp(1, MAX_SQLITE_ROWS);
        let mut cursor = stmt
            .query(rusqlite::params![limit, input.offset as i64])
            .map_err(|err| err.to_string())?;
        let mut rows = Vec::new();
        while let Some(row) = cursor.next().map_err(|err| err.to_string())? {
            rows.push(
                (0..width)
                    .map(|i| row.get_ref(i).map(sql_value).unwrap_or(Value::Null))
                    .collect(),
            );
        }
        Ok(SqliteRows { columns, rows, total })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("axe-viewers-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        dir
    }

    #[test]
    fn read_range_clamps_to_file_size() {
        let path = temp("range.bin");
        std::fs::write(&path, b"0123456789").unwrap();
        assert_eq!(read_range(path.clone(), 3, 4).unwrap(), b"3456");
        assert_eq!(read_range(path.clone(), 8, 100).unwrap(), b"89");
        assert!(read_range(path.clone(), 50, 4).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_is_opened_read_only() {
        let path = temp("data.sqlite");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE t (id INTEGER, name TEXT); INSERT INTO t VALUES (1, 'a');")
                .unwrap();
        }
        let conn = open_sqlite(path.to_str().unwrap()).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        assert!(conn.execute("INSERT INTO t VALUES (2, 'b')", []).is_err());
        assert!(conn.execute_batch("DROP TABLE t").is_err());
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn non_sqlite_file_is_rejected() {
        let path = temp("not.db");
        std::fs::write(&path, b"definitely not a database").unwrap();
        assert!(open_sqlite(path.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn quote_ident_escapes_quotes() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn zip_entries_are_listed_and_read() {
        let path = temp("archive.zip");
        {
            let file = File::create(&path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("docs/readme.txt", options).unwrap();
            writer.write_all(b"hello zip").unwrap();
            writer.finish().unwrap();
        }
        let mut archive = open_zip(path.to_str().unwrap()).unwrap();
        assert_eq!(archive.len(), 1);
        let mut entry = archive.by_name("docs/readme.txt").unwrap();
        let mut text = String::new();
        entry.read_to_string(&mut text).unwrap();
        assert_eq!(text, "hello zip");
        drop(entry);
        drop(archive);
        let _ = std::fs::remove_file(path);
    }
}
