// Lot palette (P5) — « Ouvrir dans… » VS Code, Cursor, Zed et les autres éditeurs trouvés sur
// le poste (un dossier ; un fichier à la ligne), dossier des journaux, et sous Windows
// « Relancer en administrateur ». Menu natif « Aide » (macOS, Linux) ; sous Windows, mêmes
// actions dans Réglages > À propos et dans Ctrl+K.

use crate::*;
use std::ffi::OsString;
use std::sync::OnceLock;

/// Façon de passer la ligne à l'éditeur.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Ligne {
    /// `code <dossier> -g fichier:ligne:colonne` (VS Code et ses dérivés).
    Goto,
    /// `zed fichier:ligne:colonne`, `subl fichier:ligne:colonne`.
    Suffixe,
    /// `idea --line N --column C fichier` (JetBrains).
    JetBrains,
    /// `notepad++ -nN -cC fichier` (fichiers seulement).
    NotepadPP,
}

pub(crate) struct Connu {
    pub(crate) id: &'static str,
    pub(crate) nom: &'static str,
    commandes: &'static [&'static str],
    /// Chemins d'installation habituels (variables %LOCALAPPDATA%, %ProgramFiles%, ~).
    installes: &'static [&'static str],
    pub(crate) ligne: Ligne,
}

pub(crate) const CONNUS: &[Connu] = &[
    Connu { id: "vscode", nom: "VS Code", commandes: &["code"], ligne: Ligne::Goto, installes: &[
        "%LOCALAPPDATA%/Programs/Microsoft VS Code/bin/code.cmd", "%ProgramFiles%/Microsoft VS Code/bin/code.cmd",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "~/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"] },
    Connu { id: "cursor", nom: "Cursor", commandes: &["cursor"], ligne: Ligne::Goto, installes: &[
        "%LOCALAPPDATA%/Programs/cursor/resources/app/bin/cursor.cmd", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor"] },
    Connu { id: "zed", nom: "Zed", commandes: &["zed", "zeditor"], ligne: Ligne::Suffixe, installes: &[
        "%LOCALAPPDATA%/Programs/Zed/bin/zed.exe", "/Applications/Zed.app/Contents/MacOS/cli", "~/.local/bin/zed"] },
    Connu { id: "windsurf", nom: "Windsurf", commandes: &["windsurf"], ligne: Ligne::Goto, installes: &[
        "%LOCALAPPDATA%/Programs/Windsurf/bin/windsurf.cmd", "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"] },
    Connu { id: "vscodium", nom: "VSCodium", commandes: &["codium"], ligne: Ligne::Goto, installes: &[
        "%LOCALAPPDATA%/Programs/VSCodium/bin/codium.cmd", "/Applications/VSCodium.app/Contents/Resources/app/bin/codium"] },
    Connu { id: "sublime", nom: "Sublime Text", commandes: &["subl"], ligne: Ligne::Suffixe, installes: &[
        "%ProgramFiles%/Sublime Text/subl.exe", "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"] },
    Connu { id: "idea", nom: "IntelliJ IDEA", commandes: &["idea"], ligne: Ligne::JetBrains, installes: &[] },
    Connu { id: "pycharm", nom: "PyCharm", commandes: &["pycharm"], ligne: Ligne::JetBrains, installes: &[] },
    Connu { id: "webstorm", nom: "WebStorm", commandes: &["webstorm"], ligne: Ligne::JetBrains, installes: &[] },
    Connu { id: "notepadpp", nom: "Notepad++", commandes: &["notepad++"], ligne: Ligne::NotepadPP, installes: &[
        "%ProgramFiles%/Notepad++/notepad++.exe", "%ProgramFiles(x86)%/Notepad++/notepad++.exe"] },
];

fn variable(nom: &str) -> Option<OsString> {
    std::env::var_os(nom).filter(|v| !v.is_empty())
}

/// « %LOCALAPPDATA%/… », « ~/… » → chemin réel (None si la variable manque).
fn developper(modele: &str) -> Option<PathBuf> {
    if let Some(reste) = modele.strip_prefix("~/") {
        return variable("HOME").or_else(|| variable("USERPROFILE")).map(|h| PathBuf::from(h).join(reste));
    }
    if let Some(reste) = modele.strip_prefix('%') {
        let (nom, suite) = reste.split_once('%')?;
        return variable(nom).map(|v| PathBuf::from(v).join(suite.trim_start_matches('/')));
    }
    Some(PathBuf::from(modele))
}

/// Exécutable `nom` dans le PATH (sous Windows avec les extensions de PATHEXT).
pub(crate) fn dans_le_path(nom: &str, path: Option<OsString>) -> Option<PathBuf> {
    let path = path?;
    let extensions: Vec<String> = if cfg!(windows) {
        variable("PATHEXT")
            .map(|v| v.to_string_lossy().split(';').filter(|e| !e.is_empty()).map(str::to_lowercase).collect())
            .unwrap_or_else(|| vec![".exe".into(), ".cmd".into(), ".bat".into()])
    } else {
        vec![String::new()]
    };
    for dossier in std::env::split_paths(&path) {
        for ext in &extensions {
            let candidat = dossier.join(format!("{nom}{ext}"));
            if candidat.is_file() {
                return Some(candidat);
            }
        }
    }
    None
}

fn trouver(connu: &Connu) -> Option<PathBuf> {
    connu
        .commandes
        .iter()
        .find_map(|c| dans_le_path(c, variable("PATH")))
        .or_else(|| connu.installes.iter().filter_map(|m| developper(m)).find(|p| p.is_file()))
}

static DETECTES: OnceLock<Vec<(&'static Connu, PathBuf)>> = OnceLock::new();

fn detectes() -> &'static [(&'static Connu, PathBuf)] {
    DETECTES.get_or_init(|| CONNUS.iter().filter_map(|c| trouver(c).map(|p| (c, p))).collect())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Editeur {
    id: &'static str,
    nom: &'static str,
    /// Peut ouvrir un dossier (Notepad++ : fichiers seulement).
    dossier: bool,
}

/// Éditeurs trouvés sur ce poste (cherchés une fois par lancement).
#[tauri::command]
pub(crate) async fn editeurs_detectes() -> Vec<Editeur> {
    tauri::async_runtime::spawn_blocking(|| {
        detectes()
            .iter()
            .map(|(c, _)| Editeur { id: c.id, nom: c.nom, dossier: c.ligne != Ligne::NotepadPP })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Chemin affiché aux éditeurs : sans le préfixe « \\?\ » des chemins Windows canoniques.
pub(crate) fn chemin_simple(p: &Path) -> String {
    let s = p.display().to_string();
    if let Some(reste) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{reste}");
    }
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

/// Arguments de la commande : le dossier, et le fichier à la ligne s'il y en a un.
pub(crate) fn arguments(ligne: Ligne, dossier: &str, fichier: Option<&str>, num: Option<u32>, col: Option<u32>) -> Vec<String> {
    let l = num.unwrap_or(1).max(1);
    let c = col.unwrap_or(1).max(1);
    match (ligne, fichier) {
        (Ligne::NotepadPP, Some(f)) => vec![format!("-n{l}"), format!("-c{c}"), f.to_string()],
        (Ligne::NotepadPP, None) => vec![dossier.to_string()],
        (_, None) => vec![dossier.to_string()],
        (Ligne::Goto, Some(f)) => vec![dossier.to_string(), "-g".into(), format!("{f}:{l}:{c}")],
        (Ligne::Suffixe, Some(f)) => vec![dossier.to_string(), format!("{f}:{l}:{c}")],
        (Ligne::JetBrains, Some(f)) => vec![dossier.to_string(), "--line".into(), l.to_string(), "--column".into(), c.to_string(), f.to_string()],
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OuvrirInput {
    editeur: String,
    workspace_path: String,
    /// Fichier ou dossier relatif au dossier ouvert (absent : le dossier lui-même).
    #[serde(default)]
    chemin: Option<String>,
    #[serde(default)]
    ligne: Option<u32>,
    #[serde(default)]
    colonne: Option<u32>,
}

/// Ouvre le dossier, ou un fichier (à la ligne) avec son dossier, dans l'éditeur choisi.
#[tauri::command]
pub(crate) async fn ouvrir_dans_editeur(input: OuvrirInput) -> std::result::Result<(), String> {
    let racine = normalize_workspace_root(&input.workspace_path).map_err(error_to_string)?;
    let (connu, exe) = detectes()
        .iter()
        .find(|(c, _)| c.id == input.editeur)
        .ok_or_else(|| format!("éditeur introuvable : {}", input.editeur))?;
    let cible = match input.chemin.as_deref().map(|c| c.trim_matches(['/', '\\'])).filter(|c| !c.is_empty()) {
        None => None,
        Some(relatif) => {
            let p = Path::new(relatif);
            if p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
                return Err("chemin hors du dossier".into());
            }
            Some(racine.join(p))
        }
    };
    let (dossier, fichier) = match &cible {
        Some(p) if p.is_dir() => (chemin_simple(p), None),
        Some(p) => (chemin_simple(&racine), Some(chemin_simple(p))),
        None => (chemin_simple(&racine), None),
    };
    let args = arguments(connu.ligne, &dossier, fichier.as_deref(), input.ligne, input.colonne);
    __nw_std(exe)
        .args(&args)
        .current_dir(&racine)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{} n'a pas pu être lancé : {e}", connu.nom))
}

/// Dossier des journaux : celui du service (daemon.log), à côté des données de l'appli.
pub(crate) fn dossier_journaux() -> std::result::Result<PathBuf, String> {
    let d = axecode_daemon::util::default_data_dir().map_err(|e| e.to_string())?.join("logs");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn ouvrir_dans_gestionnaire(d: &Path) -> std::result::Result<(), String> {
    let programme = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    __nw_std(programme).arg(d).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn ouvrir_dossier_journaux() -> std::result::Result<String, String> {
    let d = dossier_journaux()?;
    ouvrir_dans_gestionnaire(&d)?;
    Ok(chemin_simple(&d))
}

/// Windows : relance l'application en administrateur (fenêtre UAC) puis ferme celle-ci ;
/// si l'utilisateur refuse, rien ne change.
#[tauri::command]
pub(crate) async fn relancer_administrateur(app: AppHandle) -> std::result::Result<(), String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = chemin_simple(&exe).replace('\'', "''");
        let script = format!("Start-Process -FilePath '{exe}' -Verb RunAs");
        let sortie = __nw_std("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| e.to_string())?;
        if !sortie.status.success() {
            return Err("Relance annulée".into());
        }
        app.exit(0);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Windows seulement".into())
    }
}

pub(crate) const MENU_JOURNAUX: &str = "aide-ouvrir-journaux";

/// Menu natif « Aide » (macOS, Linux) : ouvrir le dossier des journaux.
#[cfg(not(target_os = "windows"))]
pub(crate) fn menu_aide<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Submenu<R>> {
    let journaux = tauri::menu::MenuItemBuilder::with_id(MENU_JOURNAUX, "Ouvrir le dossier des journaux").build(app)?;
    tauri::menu::Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, "Aide", true, &[&journaux])
}

/// Entrée du menu natif : vrai si elle était pour ce module.
pub(crate) fn evenement_menu(id: &str) -> bool {
    if id != MENU_JOURNAUX {
        return false;
    }
    if let Err(err) = dossier_journaux().and_then(|d| ouvrir_dans_gestionnaire(&d)) {
        tracing::warn!(%err, "dossier des journaux");
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_par_editeur() {
        assert_eq!(arguments(Ligne::Goto, "C:\\p", None, None, None), vec!["C:\\p"]);
        assert_eq!(arguments(Ligne::Goto, "C:\\p", Some("C:\\p\\a.rs"), Some(12), None), vec!["C:\\p", "-g", "C:\\p\\a.rs:12:1"]);
        assert_eq!(arguments(Ligne::Suffixe, "/p", Some("/p/a.rs"), Some(3), Some(5)), vec!["/p", "/p/a.rs:3:5"]);
        assert_eq!(arguments(Ligne::JetBrains, "/p", Some("/p/a.rs"), Some(3), None), vec!["/p", "--line", "3", "--column", "1", "/p/a.rs"]);
        assert_eq!(arguments(Ligne::NotepadPP, "C:\\p", Some("C:\\p\\a.txt"), Some(7), Some(2)), vec!["-n7", "-c2", "C:\\p\\a.txt"]);
        assert_eq!(arguments(Ligne::Goto, "/p", Some("/p/a"), Some(0), Some(0)), vec!["/p", "-g", "/p/a:1:1"]);
    }

    #[test]
    fn chemins_windows_sans_prefixe() {
        assert_eq!(chemin_simple(Path::new(r"\\?\C:\Users\S\projet")), r"C:\Users\S\projet");
        assert_eq!(chemin_simple(Path::new(r"\\?\UNC\serveur\partage")), r"\\serveur\partage");
        assert_eq!(chemin_simple(Path::new("/home/s/projet")), "/home/s/projet");
    }

    #[test]
    fn detection_dans_le_path() {
        let d = std::env::temp_dir().join(format!("savide-editeurs-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        let nom = if cfg!(windows) { "code.cmd" } else { "code" };
        fs::write(d.join(nom), "").unwrap();
        let trouve = dans_le_path("code", Some(d.clone().into_os_string()));
        assert_eq!(trouve, Some(d.join(nom)));
        assert_eq!(dans_le_path("cursor", Some(d.clone().into_os_string())), None);
        assert_eq!(dans_le_path("code", None), None);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn modeles_de_chemin() {
        std::env::set_var("SAVIDE_TEST_DOSSIER", "/opt/x");
        assert_eq!(developper("%SAVIDE_TEST_DOSSIER%/bin/code"), Some(PathBuf::from("/opt/x").join("bin/code")));
        assert_eq!(developper("%SAVIDE_ABSENTE_XYZ%/a"), None);
        assert_eq!(developper("/Applications/Zed.app"), Some(PathBuf::from("/Applications/Zed.app")));
    }

    #[test]
    fn ids_uniques() {
        let mut ids: Vec<_> = CONNUS.iter().map(|c| c.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CONNUS.len());
    }
}
