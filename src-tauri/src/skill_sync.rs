// axe:e4 — empreintes des skills du répertoire partagé (/srv/axe/commun/skills).
// Renvoie nom -> "taille:mtime" du SKILL.md de chaque sous-dossier. Dossier
// absent (poste Windows sans montage) : erreur, l'UI retentera au tick suivant.
use std::collections::BTreeMap;
use std::time::UNIX_EPOCH;

#[tauri::command]
pub(crate) fn shared_skills_fingerprints(dir: String) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("{dir}: {e}"))?;
    for entry in entries.flatten() {
        let skill = entry.path().join("SKILL.md");
        let Ok(meta) = std::fs::metadata(&skill) else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0);
        out.insert(entry.file_name().to_string_lossy().into_owned(), format!("{}:{}", meta.len(), mtime));
    }
    Ok(out)
}
