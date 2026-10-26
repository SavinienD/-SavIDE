//! axe:dossiers-anciens — migration UNE FOIS des anciens dossiers cachés du
//! projet (`<projet>/.axecode/`, `<projet>/.atelier/`) vers les données de
//! l'appli (`<données>/projects/<nom>-<empreinte>/`).
//!
//! Fichier par fichier : copie (sans jamais écraser), vérification (taille +
//! empreinte), PUIS suppression de l'original. Conflit (même chemin, contenu
//! différent) : on garde les deux (suffixe `-ancien-N`, ou, pour le harnais,
//! copie sous `migration-conflits/` pour ne pas créer d'entrée en double).
//! Un échec laisse l'original en place ; le témoin n'est écrit que si tout
//! est passé (sinon on réessaie à la prochaine ouverture, sans effet sur ce
//! qui a déjà été déplacé). Les éléments inconnus restent et sont signalés.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Témoin (dans les données du projet) : migration faite.
pub const MARKER: &str = "anciens-dossiers-migres.json";
/// Sous-dossiers connus et leur destination (même nom dans les données).
pub const KNOWN: &[&str] = &["harness", "images", "plans", "agents", "corbeille", "skills"];
const SOURCES: &[&str] = &[".axecode", ".atelier"]; // rebrand:keep

#[derive(Debug, Default, serde::Serialize)]
pub struct Report {
    pub moved: Vec<String>,
    pub conflicts: Vec<String>,
    pub failed: Vec<String>,
    pub unknown: Vec<String>,
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Lance la migration si besoin. `home` = dossier personnel (son `.axecode`
/// est le harnais GLOBAL : jamais touché, ex. projet ouvert sur HOME).
pub fn migrate(workspace_root: &Path, project_data: &Path, home: Option<&Path>) -> Option<Report> {
    migrate_with(workspace_root, project_data, home, &|src, dst| fs::copy(src, dst).map(|_| ()))
}

pub fn migrate_with(
    workspace_root: &Path,
    project_data: &Path,
    home: Option<&Path>,
    copy: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Option<Report> {
    if project_data.join(MARKER).exists() {
        return None;
    }
    let mut homes: Vec<PathBuf> = home.map(Path::to_path_buf).into_iter().collect();
    if let Some(d) = directories::BaseDirs::new() {
        homes.push(d.home_dir().to_path_buf());
    }
    let sources: Vec<PathBuf> = SOURCES
        .iter()
        .map(|n| workspace_root.join(n))
        .filter(|p| p.is_dir())
        .filter(|p| !homes.iter().any(|h| same_dir(workspace_root, h)) || !p.ends_with(".axecode"))
        .filter(|p| !same_dir(p, project_data) && !project_data.starts_with(p))
        .collect();
    let mut report = Report::default();
    for src_root in &sources {
        let Ok(rd) = fs::read_dir(src_root) else { continue };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if KNOWN.contains(&name.as_str()) && path.is_dir() {
                let harness = name == "harness";
                move_tree(&path, &project_data.join(&name), project_data, harness, copy, &mut report);
                remove_empty_dirs(&path);
            } else {
                report.unknown.push(path.display().to_string());
            }
        }
        remove_empty_dirs(src_root);
    }
    for u in &report.unknown {
        tracing::warn!(chemin = %u, "ancien dossier du projet : élément inconnu laissé en place");
    }
    for f in &report.failed {
        tracing::warn!(erreur = %f, "ancien dossier du projet : copie échouée, original gardé");
    }
    if report.failed.is_empty() {
        let _ = fs::create_dir_all(project_data);
        let _ = fs::write(
            project_data.join(MARKER),
            serde_json::to_string_pretty(&report).unwrap_or_default(),
        );
    }
    if !report.moved.is_empty() || !report.unknown.is_empty() || !report.failed.is_empty() {
        tracing::info!(deplaces = report.moved.len(), conflits = report.conflicts.len(),
            echecs = report.failed.len(), inconnus = report.unknown.len(), "migration des anciens dossiers du projet");
    }
    Some(report)
}

fn digest(path: &Path) -> std::io::Result<(u64, u64)> {
    let mut f = fs::File::open(path)?;
    let mut buf = [0u8; 65536];
    let (mut len, mut h) = (0u64, 0xcbf29ce484222325u64);
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        len += n as u64;
        for b in &buf[..n] {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    Ok((len, h))
}

fn suffixed(target: &Path, n: usize) -> PathBuf {
    let stem = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let name = match target.extension() {
        Some(ext) => format!("{stem}-ancien-{n}.{}", ext.to_string_lossy()),
        None => format!("{stem}-ancien-{n}"),
    };
    target.with_file_name(name)
}

fn move_tree(
    src: &Path,
    dst: &Path,
    project_data: &Path,
    harness: bool,
    copy: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
    report: &mut Report,
) {
    let Ok(rd) = fs::read_dir(src) else {
        report.failed.push(format!("lecture impossible : {}", src.display()));
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if name == "__pycache__" {
            let _ = fs::remove_dir_all(&path);
            continue;
        }
        let target = dst.join(&name);
        if path.is_dir() {
            move_tree(&path, &target, project_data, harness, copy, report);
            remove_empty_dirs(&path);
            continue;
        }
        // L'index du harnais est recalculé depuis les fichiers.
        if harness && name == crate::store::INDEX_FILE_NAME {
            let _ = fs::remove_file(&path);
            continue;
        }
        move_file(&path, &target, project_data, harness, copy, report);
    }
}

fn move_file(
    src: &Path,
    target: &Path,
    project_data: &Path,
    harness: bool,
    copy: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
    report: &mut Report,
) {
    let fail = |report: &mut Report, why: String| report.failed.push(format!("{} : {why}", src.display()));
    let want = match digest(src) {
        Ok(d) => d,
        Err(e) => return fail(report, e.to_string()),
    };
    let mut dest = target.to_path_buf();
    if dest.exists() {
        if digest(&dest).ok() == Some(want) {
            // Déjà présent à l'identique (ex. copie d'une migration précédente).
            if let Err(e) = fs::remove_file(src) {
                fail(report, e.to_string());
            } else {
                report.moved.push(src.display().to_string());
            }
            return;
        }
        let base = if harness {
            let rel = target.strip_prefix(project_data).unwrap_or(target);
            project_data.join("migration-conflits").join(rel)
        } else {
            target.to_path_buf()
        };
        dest = base.clone();
        let mut n = 1;
        while dest.exists() || (!harness && dest == *target) {
            dest = suffixed(&base, n);
            n += 1;
        }
        report.conflicts.push(format!("{} -> {}", src.display(), dest.display()));
    }
    if let Some(parent) = dest.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return fail(report, e.to_string());
        }
    }
    let copied = copy(src, &dest).and_then(|_| digest(&dest));
    match copied {
        Ok(got) if got == want => match fs::remove_file(src) {
            Ok(()) => report.moved.push(src.display().to_string()),
            Err(e) => fail(report, e.to_string()),
        },
        Ok(_) => {
            let _ = fs::remove_file(&dest);
            fail(report, "copie différente de l'original".into());
        }
        Err(e) => {
            let _ = fs::remove_file(&dest);
            fail(report, e.to_string());
        }
    }
}

/// Supprime `dir` et ses sous-dossiers s'ils sont vides (jamais un fichier).
fn remove_empty_dirs(dir: &Path) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                remove_empty_dirs(&e.path());
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

/// Dossier des skills du projet dans les données de l'appli (les anciennes
/// `<projet>/.axecode/skills` y sont déplacées). Lance la migration si besoin.
pub fn project_skills_dir(workspace_root: &Path) -> PathBuf {
    let data = crate::datadir::project_data_dir(workspace_root);
    migrate(workspace_root, &data, None);
    data.join("skills")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EntryKind, HarnessPaths, HarnessStore, NewEntry, Scope};

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("axecode-anciens-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn new(title: &str) -> NewEntry {
        serde_json::from_value(serde_json::json!({"title": title, "body": format!("corps {title}")})).unwrap()
    }
    fn write(p: &Path, s: &str) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, s).unwrap();
    }
    fn old_store(dir: &Path, home: &Path) -> HarnessStore {
        HarnessStore::new(HarnessPaths {
            global_root: home.join(".axecode/harness"),
            project_root: dir.join("harness"),
            legacy_project_root: None,
            team_root: None,
        })
    }
    fn summary(s: &HarnessStore) -> Vec<(String, String, String)> {
        let mut v: Vec<_> = s
            .list(None, Some(Scope::Project))
            .unwrap()
            .into_iter()
            .map(|e| (e.meta.id.clone(), e.meta.title.clone(), e.body.trim().to_string()))
            .collect();
        v.sort();
        v
    }

    /// Vieux projet complet (.axecode + .atelier) -> tout au nouvel endroit, rien de perdu.
    #[test]
    fn vieux_projet_complet_migre_une_fois() {
        let root = tmp();
        let (ws, home) = (root.join("projet"), root.join("home"));
        fs::create_dir_all(&ws).unwrap();
        let old = ws.join(".axecode");
        let o = old_store(&old, &home);
        o.create(Scope::Project, EntryKind::PromptNote, new("Note")).unwrap();
        o.create(Scope::Project, EntryKind::Memory, new("Mémoire")).unwrap();
        o.create(Scope::Project, EntryKind::Skill, new("outil-maison")).unwrap();
        let plan = o.create(Scope::Project, EntryKind::PromptNote, new("Plan archivé")).unwrap();
        let s = old_store(&ws.join(".atelier"), &home);
        s.create(Scope::Project, EntryKind::Memory, new("Ancienne atelier")).unwrap();
        write(&old.join("harness/skills/__pycache__/x.pyc"), "cache");
        write(&old.join("images/a.png"), "PNG");
        write(&old.join("plans/plan-1.md"), "# Plan");
        write(&old.join("agents/t1/task.json"), "{}");
        write(&old.join("corbeille/123/demo.txt"), "supprimé");
        write(&old.join("skills/ma-skill/SKILL.md"), "---\nname: ma-skill\n---\nx");
        write(&ws.join(".atelier/skills/vieille/SKILL.md"), "---\nname: vieille\n---\ny");
        write(&ws.join(".atelier/images/a.png"), "AUTRE"); // conflit => on garde les deux
        let mut before = summary(&o);
        before.extend(summary(&s));
        before.sort();

        let paths = HarnessPaths::with_home(&ws, Some(home.clone()));
        let data = paths.project_root.parent().unwrap().to_path_buf();
        let store = HarnessStore::new(paths.clone());
        assert_eq!(summary(&store), before, "harness.list identique");
        assert!(store.list(None, Some(Scope::Project)).unwrap().iter().any(|e| e.meta.id == plan.meta.id));
        assert!(paths.legacy_project_root.is_none());
        assert!(paths.skills_paths().contains(&data.join("harness/skills")));
        assert!(!ws.join(".axecode").exists() && !ws.join(".atelier").exists(), "plus de dossier caché");
        assert_eq!(fs::read_to_string(data.join("images/a.png")).unwrap(), "PNG");
        assert_eq!(fs::read_to_string(data.join("images/a-ancien-1.png")).unwrap(), "AUTRE");
        assert!(data.join("plans/plan-1.md").is_file());
        assert!(data.join("agents/t1/task.json").is_file());
        assert!(data.join("corbeille/123/demo.txt").is_file());
        assert!(data.join("skills/ma-skill/SKILL.md").is_file());
        assert!(data.join("skills/vieille/SKILL.md").is_file());
        assert!(data.join(MARKER).is_file());

        // 2e ouverture : aucun effet.
        let snapshot = |d: &Path| {
            let mut v = Vec::new();
            fn walk(d: &Path, v: &mut Vec<PathBuf>) {
                for e in fs::read_dir(d).unwrap().flatten() {
                    if e.path().is_dir() { walk(&e.path(), v) } else { v.push(e.path()) }
                }
            }
            walk(d, &mut v);
            v.sort();
            v
        };
        let s1 = snapshot(&data);
        write(&ws.join(".axecode/plans/nouveau.md"), "après");
        let again = HarnessPaths::with_home(&ws, Some(home.clone()));
        assert_eq!(summary(&HarnessStore::new(again)), before);
        assert_eq!(snapshot(&data), s1);
        assert!(ws.join(".axecode/plans/nouveau.md").is_file(), "plus jamais touché après le témoin");
        let _ = fs::remove_dir_all(&root);
    }

    /// Fichier inconnu : laissé et signalé ; dossier gardé.
    #[test]
    fn inconnu_laisse_en_place() {
        let root = tmp();
        let ws = root.join("p");
        write(&ws.join(".axecode/notes-perso.txt"), "à moi");
        write(&ws.join(".axecode/images/i.png"), "i");
        let data = root.join("data");
        let r = migrate(&ws, &data, Some(&root.join("home"))).unwrap();
        assert_eq!(r.unknown.len(), 1);
        assert!(ws.join(".axecode/notes-perso.txt").is_file());
        assert!(!ws.join(".axecode/images").exists());
        assert!(data.join("images/i.png").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    /// Échec de copie : original intact, pas de témoin, réessai possible.
    #[test]
    fn echec_de_copie_garde_l_original() {
        let root = tmp();
        let ws = root.join("p");
        write(&ws.join(".axecode/plans/p.md"), "plan");
        write(&ws.join(".axecode/images/i.png"), "img");
        let data = root.join("data");
        let home = root.join("home");
        let r = migrate_with(&ws, &data, Some(&home), &|s, d| {
            if s.ends_with("p.md") {
                fs::write(d, "tronqué")?; // copie corrompue : détectée par l'empreinte
                Ok(())
            } else {
                fs::copy(s, d).map(|_| ())
            }
        })
        .unwrap();
        assert_eq!(r.failed.len(), 1);
        assert_eq!(fs::read_to_string(ws.join(".axecode/plans/p.md")).unwrap(), "plan");
        assert!(!data.join("plans/p.md").exists());
        assert!(!data.join(MARKER).exists());
        let r = migrate(&ws, &data, Some(&home)).unwrap();
        assert!(r.failed.is_empty());
        assert_eq!(fs::read_to_string(data.join("plans/p.md")).unwrap(), "plan");
        assert!(!ws.join(".axecode").exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// Projet ouvert sur le dossier personnel : son .axecode = harnais global, jamais touché.
    #[test]
    fn home_axecode_jamais_touche() {
        let root = tmp();
        write(&root.join(".axecode/harness/memories/x.md"), "global");
        let r = migrate(&root, &root.join("data"), Some(&root)).unwrap();
        assert!(r.moved.is_empty());
        assert!(root.join(".axecode/harness/memories/x.md").is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
