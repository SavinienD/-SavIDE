// axe:import — « Importer ce dossier dans mon espace » : lit un dossier LOCAL (fichiers texte,
// sans .git / node_modules / target, ≤ 2 Mo par fichier, ≤ 5000 fichiers) pour que l'interface
// le recopie dans l'espace cloud via les écritures habituelles.
use std::path::Path;

#[derive(serde::Serialize)]
pub(crate) struct FichierLocal { chemin: String, contenu: String }

const EXCLUS: &[&str] = &[".git", "node_modules", "target", ".venv", "__pycache__", "dist"];

fn parcourir(racine: &Path, d: &Path, out: &mut Vec<FichierLocal>, ignores: &mut usize) {
    let Ok(it) = std::fs::read_dir(d) else { return };
    for e in it.flatten() {
        let p = e.path();
        let nom = e.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if !EXCLUS.contains(&nom.as_str()) { parcourir(racine, &p, out, ignores); }
            continue;
        }
        if out.len() >= 5000 { *ignores += 1; continue; }
        let ok = std::fs::metadata(&p).map(|m| m.len() <= 2 * 1024 * 1024).unwrap_or(false);
        match (ok, std::fs::read_to_string(&p)) {
            (true, Ok(contenu)) => {
                let chemin = p.strip_prefix(racine).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                out.push(FichierLocal { chemin, contenu });
            }
            _ => *ignores += 1,
        }
    }
}

#[tauri::command]
pub(crate) fn local_folder_files(dir: String) -> Result<serde_json::Value, String> {
    let racine = Path::new(&dir);
    if !racine.is_dir() { return Err(format!("{dir} n'est pas un dossier")); }
    let (mut out, mut ignores) = (Vec::new(), 0usize);
    parcourir(racine, racine, &mut out, &mut ignores);
    Ok(serde_json::json!({ "fichiers": out, "ignores": ignores }))
}


// axe:push-dossier - pousse un dossier ENTIER (binaires compris) dans l'espace cloud.
fn lister(d: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(it) = std::fs::read_dir(d) else { return };
    for e in it.flatten() {
        let p = e.path();
        if p.is_dir() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n != "node_modules" && n != "target" { lister(&p, out); }
        } else { out.push(p); }
    }
}

#[tauri::command]
pub(crate) async fn push_folder_cloud(app: tauri::AppHandle, connection: String, dir: String) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    use tauri::Emitter;
    if crate::EDITION_LOCALE {
        return Err("Édition locale : pas d'envoi vers le cloud.".into());
    }
    let racine = Path::new(&dir);
    if !racine.is_dir() { return Err(format!("{dir} n'est pas un dossier")); }
    let nom = racine.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "import".into());
    let mut fichiers = Vec::new();
    lister(racine, &mut fichiers);
    let total = fichiers.len();
    let mut octets = 0usize;
    for (i, f) in fichiers.iter().enumerate() {
        let rel = f.strip_prefix(racine).unwrap_or(f).to_string_lossy().replace('\\', "/");
        let data = std::fs::read(f).map_err(|e| format!("{rel}: {e}"))?;
        octets += data.len();
        let chunks: Vec<&[u8]> = if data.is_empty() { vec![&[][..]] } else { data.chunks(512 * 1024).collect() };
        for (k, c) in chunks.iter().enumerate() {
            crate::connections::call_on(&app, Some(&connection), "fs.write_bytes", serde_json::json!({
                "path": format!("{nom}/{rel}"),
                "data": base64::engine::general_purpose::STANDARD.encode(c),
                "append": k > 0,
            })).await.map_err(|e| format!("{rel}: {e}"))?;
        }
        let _ = app.emit("axe://push-progress", serde_json::json!({"done": i + 1, "total": total, "file": rel}));
    }
    Ok(serde_json::json!({"dossier": nom, "fichiers": total, "octets": octets}))
}
